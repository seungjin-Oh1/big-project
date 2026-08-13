"""유료 자원을 지운다. state.json에 적힌 것만 건드린다.

무료인 것(VPC, 서브넷, 라우팅, IGW, 보안그룹, S3 Endpoint)은 남긴다. 만들어
두는 것만으로는 과금되지 않고, 별첨에 넣을 구조도 캡처는 그것들로 충분하다.

지우는 순서가 중요하다. 의존 관계를 거슬러 올라가야 한다.
    1  EC2 terminate     NAT를 지우기 전에 없어야 한다
    2  RDS 삭제          서브넷 그룹보다 먼저
    3  DB 서브넷 그룹
    4  NAT Gateway       가장 비싸고 가장 빠뜨리기 쉽다
    5  탄력적 IP         NAT가 사라진 뒤에야 놓을 수 있다
    6  프라이빗 기본 경로  NAT가 사라지면 blackhole로 남는다
    7  키 페어

"중지"로는 부족한 것들이다. EBS는 인스턴스를 terminate해야 같이 사라지고
(create_compute.py에서 DeleteOnTermination을 켜 두었다), NAT는 중지 자체가
없어서 삭제만이 방법이며, 탄력적 IP는 붙어 있지 않아도 과금된다.

실행:
    python deploy/aws/teardown.py          무엇을 지울지 보여주고 묻는다
    python deploy/aws/teardown.py --yes    묻지 않는다
"""

import json
import os
import sys

import boto3
from botocore.exceptions import ClientError
from dotenv import dotenv_values

PROJECT = "bigproject"
REGION = "ap-northeast-2"
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
KEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"{PROJECT}-key.pem")


def load_state():
    if not os.path.exists(STATE_PATH):
        sys.exit("state.json이 없습니다. 지울 것이 없습니다.")
    with open(STATE_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def session():
    cfg = dotenv_values(r"C:\big-project\backend\ai-api\.env")
    return boto3.session.Session(
        aws_access_key_id=cfg["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=cfg["AWS_SECRET_ACCESS_KEY"],
        region_name=REGION,
    )


def main():
    state = load_state()

    plan = []
    if state.get("instances"):
        plan.append(f"EC2 {len(state['instances'])}대 terminate — {', '.join(state['instances'].values())}")
    if state.get("db_id"):
        plan.append(f"RDS {state['db_id']} 삭제 (최종 스냅샷 없음)")
    if state.get("nat_id"):
        plan.append(f"NAT Gateway {state['nat_id']} 삭제")
    if state.get("eip_alloc_id"):
        plan.append(f"탄력적 IP {state['eip_alloc_id']} 해제")
    if state.get("key_name"):
        plan.append(f"키 페어 {state['key_name']} 삭제")

    if not plan:
        print("지울 유료 자원이 없습니다.")
        return

    print("지울 것")
    for p in plan:
        print(f"    {p}")
    print("\n남길 것 (전부 무료)")
    print("    VPC, 서브넷 5개, 라우팅 테이블, IGW, 보안그룹 3개, S3 Endpoint")

    if "--yes" not in sys.argv:
        if input("\n지울까요? (yes 입력) ").strip().lower() != "yes":
            sys.exit("취소했습니다.")

    s = session()
    ec2 = s.client("ec2")
    rds = s.client("rds")

    # ── 1. EC2 ───────────────────────────────────────────────────────────
    ids = list(state.get("instances", {}).values())
    if ids:
        try:
            ec2.terminate_instances(InstanceIds=ids)
            print(f"\n  terminate 요청  {', '.join(ids)}")
            ec2.get_waiter("instance_terminated").wait(InstanceIds=ids)
            print("  완료      EC2 (EBS도 같이 사라졌다)")
        except ClientError as e:
            print(f"  건너뜀    EC2 -> {e.response['Error']['Code']}")
        state.pop("instances", None)
        state.pop("addresses", None)
        save_state(state)

    # ── 2. RDS ───────────────────────────────────────────────────────────
    if state.get("db_id"):
        try:
            # 스냅샷을 남기면 그것도 저장 요금이 붙는다. 확인용 DB라 남기지 않는다.
            rds.delete_db_instance(DBInstanceIdentifier=state["db_id"],
                                   SkipFinalSnapshot=True,
                                   DeleteAutomatedBackups=True)
            print(f"  삭제 요청  RDS {state['db_id']} — 몇 분 걸린다")
            rds.get_waiter("db_instance_deleted").wait(DBInstanceIdentifier=state["db_id"])
            print("  완료      RDS")
        except ClientError as e:
            print(f"  건너뜀    RDS -> {e.response['Error']['Code']}")
        state.pop("db_id", None)
        state.pop("db_password", None)
        state.pop("db_endpoint", None)
        save_state(state)

    # ── 3. DB 서브넷 그룹 ────────────────────────────────────────────────
    try:
        rds.delete_db_subnet_group(DBSubnetGroupName=f"{PROJECT}-db-subnet-group")
        print("  삭제      DB 서브넷 그룹")
    except ClientError as e:
        if e.response["Error"]["Code"] != "DBSubnetGroupNotFoundFault":
            print(f"  건너뜀    DB 서브넷 그룹 -> {e.response['Error']['Code']}")

    # ── 4. NAT Gateway ───────────────────────────────────────────────────
    if state.get("nat_id"):
        try:
            ec2.delete_nat_gateway(NatGatewayId=state["nat_id"])
            print(f"  삭제 요청  NAT {state['nat_id']} — 사라질 때까지 기다린다")
            ec2.get_waiter("nat_gateway_deleted").wait(NatGatewayIds=[state["nat_id"]])
            print("  완료      NAT")
        except ClientError as e:
            print(f"  건너뜀    NAT -> {e.response['Error']['Code']}")
        state.pop("nat_id", None)
        save_state(state)

    # ── 5. 탄력적 IP ─────────────────────────────────────────────────────
    # NAT에 붙어 있는 동안은 해제되지 않는다. 그래서 NAT 다음이다.
    if state.get("eip_alloc_id"):
        try:
            ec2.release_address(AllocationId=state["eip_alloc_id"])
            print("  해제      탄력적 IP")
        except ClientError as e:
            print(f"  건너뜀    탄력적 IP -> {e.response['Error']['Code']}")
        state.pop("eip_alloc_id", None)
        save_state(state)

    # ── 6. 프라이빗 기본 경로 ────────────────────────────────────────────
    # NAT가 사라지면 이 경로는 blackhole로 남는다. 과금은 없지만 다음에 다시
    # 만들 때 RouteAlreadyExists로 막힌다.
    if state.get("rt_private"):
        try:
            ec2.delete_route(RouteTableId=state["rt_private"],
                             DestinationCidrBlock="0.0.0.0/0")
            print("  삭제      프라이빗 기본 경로")
        except ClientError as e:
            if e.response["Error"]["Code"] != "InvalidRoute.NotFound":
                print(f"  건너뜀    기본 경로 -> {e.response['Error']['Code']}")

    # ── 7. 키 페어 ───────────────────────────────────────────────────────
    if state.get("key_name"):
        try:
            ec2.delete_key_pair(KeyName=state["key_name"])
            print(f"  삭제      키 페어 {state['key_name']}")
        except ClientError as e:
            print(f"  건너뜀    키 페어 -> {e.response['Error']['Code']}")
        state.pop("key_name", None)
        if os.path.exists(KEY_PATH):
            os.remove(KEY_PATH)
        save_state(state)

    print("\n유료 자원을 정리했다. 무료 구조는 그대로 남아 있다.")
    print("콘솔에서 한 번 더 확인할 것: NAT Gateway, 탄력적 IP, EBS 볼륨, RDS 스냅샷")


if __name__ == "__main__":
    main()
