"""VPC 네트워크를 만든다. 여기서 만드는 것은 전부 무료다.

무엇을 만드나 (docs/deploy/vpc-architecture.md 설계 그대로)
    VPC 10.0.0.0/16
    서브넷 5개   public-a/c, private-app-a, private-db-a/c
    인터넷 게이트웨이 + 퍼블릭 라우팅 테이블
    프라이빗 라우팅 테이블 (NAT는 아직 안 붙인다)
    보안그룹 3개  sg-web / sg-app / sg-db
    S3 Gateway Endpoint

무엇을 안 만드나 (과금되는 것)
    NAT Gateway, EC2, 탄력적 IP, RDS
    → 실제로 올릴 때 따로 만든다. 여기서 만들면 켜두는 내내 돈이 나간다.

왜 스크립트로 하나
    콘솔에서 클릭으로 만들면 "무엇을 만들었는지"가 기억에 남는다. 지울 때 NAT
    하나만 빠뜨려도 월 $35이 계속 나간다. 만든 것의 ID를 state 파일에 적어 두고,
    teardown.py가 그 파일만 보고 역순으로 지운다.

여러 번 돌려도 안전하다 — 이름표(Name 태그)로 이미 있는지 보고 건너뛴다.

실행:
    python deploy/aws/create_network.py
"""

import json
import os
import sys

import boto3
from botocore.exceptions import ClientError
from dotenv import dotenv_values

PROJECT = "bigproject"
REGION = "ap-northeast-2"
VPC_CIDR = "10.0.0.0/16"

# (이름, CIDR, AZ, 퍼블릭인가)
SUBNETS = [
    ("public-a",      "10.0.1.0/24",  "ap-northeast-2a", True),
    ("public-c",      "10.0.2.0/24",  "ap-northeast-2c", True),
    ("private-app-a", "10.0.11.0/24", "ap-northeast-2a", False),
    ("private-db-a",  "10.0.21.0/24", "ap-northeast-2a", False),
    ("private-db-c",  "10.0.22.0/24", "ap-northeast-2c", False),
]

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def client():
    # 키는 ai-api의 .env를 쓴다. 계정에 하나뿐이고 이미 S3에 쓰고 있는 것이다.
    cfg = dotenv_values(r"C:\big-project\backend\ai-api\.env")
    if not cfg.get("AWS_ACCESS_KEY_ID"):
        sys.exit("AWS_ACCESS_KEY_ID를 찾지 못했습니다.")
    return boto3.client(
        "ec2",
        aws_access_key_id=cfg["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=cfg["AWS_SECRET_ACCESS_KEY"],
        region_name=REGION,
    )


def tags(name, kind):
    return [{"ResourceType": kind, "Tags": [
        {"Key": "Name", "Value": name},
        {"Key": "Project", "Value": PROJECT},
    ]}]


def find_by_name(ec2, describe, key, name):
    """이름표로 이미 있는지 본다. 여러 번 돌려도 중복 생성되지 않게."""
    resp = getattr(ec2, describe)(Filters=[{"Name": "tag:Name", "Values": [name]}])
    items = resp[key]
    return items[0] if items else None


def main():
    ec2 = client()
    state = load_state()

    # ── VPC ──────────────────────────────────────────────────────────────
    existing = find_by_name(ec2, "describe_vpcs", "Vpcs", f"{PROJECT}-vpc")
    if existing:
        vpc_id = existing["VpcId"]
        print(f"  이미 있음  VPC {vpc_id}")
    else:
        vpc_id = ec2.create_vpc(
            CidrBlock=VPC_CIDR,
            TagSpecifications=tags(f"{PROJECT}-vpc", "vpc"),
        )["Vpc"]["VpcId"]
        ec2.get_waiter("vpc_available").wait(VpcIds=[vpc_id])
        # DNS 이름을 켜지 않으면 인스턴스가 서로를 이름으로 못 찾고,
        # S3 Gateway Endpoint도 제대로 동작하지 않는다.
        ec2.modify_vpc_attribute(VpcId=vpc_id, EnableDnsSupport={"Value": True})
        ec2.modify_vpc_attribute(VpcId=vpc_id, EnableDnsHostnames={"Value": True})
        print(f"  생성      VPC {vpc_id}  {VPC_CIDR}")
    state["vpc_id"] = vpc_id

    # ── 인터넷 게이트웨이 ────────────────────────────────────────────────
    existing = find_by_name(ec2, "describe_internet_gateways", "InternetGateways",
                            f"{PROJECT}-igw")
    if existing:
        igw_id = existing["InternetGatewayId"]
        print(f"  이미 있음  IGW {igw_id}")
    else:
        igw_id = ec2.create_internet_gateway(
            TagSpecifications=tags(f"{PROJECT}-igw", "internet-gateway"),
        )["InternetGateway"]["InternetGatewayId"]
        ec2.attach_internet_gateway(InternetGatewayId=igw_id, VpcId=vpc_id)
        print(f"  생성      IGW {igw_id}")
    state["igw_id"] = igw_id

    # ── 서브넷 ───────────────────────────────────────────────────────────
    subnet_ids = state.get("subnets", {})
    for name, cidr, az, is_public in SUBNETS:
        full = f"{PROJECT}-{name}"
        existing = find_by_name(ec2, "describe_subnets", "Subnets", full)
        if existing:
            sid = existing["SubnetId"]
            print(f"  이미 있음  서브넷 {full:26} {sid}")
        else:
            sid = ec2.create_subnet(
                VpcId=vpc_id, CidrBlock=cidr, AvailabilityZone=az,
                TagSpecifications=tags(full, "subnet"),
            )["Subnet"]["SubnetId"]
            if is_public:
                # 퍼블릭 서브넷의 인스턴스만 공인 IP를 자동으로 받는다.
                # 프라이빗에 켜면 인터넷에서 닿을 수 있게 되어 설계가 무너진다.
                ec2.modify_subnet_attribute(SubnetId=sid,
                                            MapPublicIpOnLaunch={"Value": True})
            print(f"  생성      서브넷 {full:26} {sid}  {cidr}  {az}")
        subnet_ids[name] = sid
    state["subnets"] = subnet_ids

    # ── 라우팅 테이블 ────────────────────────────────────────────────────
    # 퍼블릭: 0.0.0.0/0 → IGW
    existing = find_by_name(ec2, "describe_route_tables", "RouteTables",
                            f"{PROJECT}-rt-public")
    if existing:
        rt_public = existing["RouteTableId"]
        print(f"  이미 있음  라우팅(퍼블릭) {rt_public}")
    else:
        rt_public = ec2.create_route_table(
            VpcId=vpc_id,
            TagSpecifications=tags(f"{PROJECT}-rt-public", "route-table"),
        )["RouteTable"]["RouteTableId"]
        ec2.create_route(RouteTableId=rt_public, DestinationCidrBlock="0.0.0.0/0",
                         GatewayId=igw_id)
        print(f"  생성      라우팅(퍼블릭) {rt_public}  0.0.0.0/0 → IGW")
    state["rt_public"] = rt_public

    # 프라이빗: 지금은 로컬 경로만. NAT는 유료라 나중에 붙인다.
    existing = find_by_name(ec2, "describe_route_tables", "RouteTables",
                            f"{PROJECT}-rt-private")
    if existing:
        rt_private = existing["RouteTableId"]
        print(f"  이미 있음  라우팅(프라이빗) {rt_private}")
    else:
        rt_private = ec2.create_route_table(
            VpcId=vpc_id,
            TagSpecifications=tags(f"{PROJECT}-rt-private", "route-table"),
        )["RouteTable"]["RouteTableId"]
        print(f"  생성      라우팅(프라이빗) {rt_private}  (NAT 미연결)")
    state["rt_private"] = rt_private

    # 서브넷에 라우팅 테이블 연결
    for name, _, _, is_public in SUBNETS:
        rt = rt_public if is_public else rt_private
        sid = subnet_ids[name]
        assoc = ec2.describe_route_tables(
            Filters=[{"Name": "association.subnet-id", "Values": [sid]}])["RouteTables"]
        if any(a["RouteTableId"] == rt for a in assoc):
            continue
        ec2.associate_route_table(RouteTableId=rt, SubnetId=sid)
        print(f"  연결      {name:26} → {'퍼블릭' if is_public else '프라이빗'} 라우팅")

    # ── 보안그룹 ─────────────────────────────────────────────────────────
    # CIDR이 아니라 서로를 참조하게 만든다. IP를 적으면 인스턴스를 바꿀 때마다
    # 따라 고쳐야 하고, 실수로 넓게 여는 일이 생긴다.
    sgs = state.get("security_groups", {})

    def ensure_sg(name, desc):
        full = f"{PROJECT}-{name}"
        resp = ec2.describe_security_groups(Filters=[
            {"Name": "group-name", "Values": [full]},
            {"Name": "vpc-id", "Values": [vpc_id]},
        ])["SecurityGroups"]
        if resp:
            print(f"  이미 있음  보안그룹 {full:20} {resp[0]['GroupId']}")
            return resp[0]["GroupId"]
        gid = ec2.create_security_group(
            GroupName=full, Description=desc, VpcId=vpc_id,
            TagSpecifications=tags(full, "security-group"),
        )["GroupId"]
        print(f"  생성      보안그룹 {full:20} {gid}")
        return gid

    # 설명은 ASCII만 받는다(AWS 제약). 한글을 넣으면 InvalidParameterValue로 막힌다.
    sg_web = ensure_sg("sg-web", "nginx - only tier reachable from internet")
    sg_app = ensure_sg("sg-app", "core-api/ai-api/stt - from sg-web only")
    sg_db = ensure_sg("sg-db", "postgres - from sg-app only")
    sgs.update({"web": sg_web, "app": sg_app, "db": sg_db})
    state["security_groups"] = sgs

    def allow(gid, port, source_sg=None, cidr=None, note=""):
        perm = {
            "IpProtocol": "tcp", "FromPort": port, "ToPort": port,
        }
        if source_sg:
            perm["UserIdGroupPairs"] = [{"GroupId": source_sg, "Description": note}]
        else:
            perm["IpRanges"] = [{"CidrIp": cidr, "Description": note}]
        try:
            ec2.authorize_security_group_ingress(GroupId=gid, IpPermissions=[perm])
            src = source_sg or cidr
            print(f"  규칙      {gid} ← {port:5}  from {src}  ({note})")
        except ClientError as e:
            if e.response["Error"]["Code"] != "InvalidPermission.Duplicate":
                raise

    # 규칙 설명도 ASCII만 받는다(AWS 제약).
    allow(sg_web, 80, cidr="0.0.0.0/0", note="HTTP")
    allow(sg_web, 443, cidr="0.0.0.0/0", note="HTTPS")
    # 8080: 브라우저 요청을 nginx가 넘긴다
    allow(sg_app, 8080, source_sg=sg_web, note="core-api from nginx")
    # 9000: Twilio /webhook을 nginx가 넘긴다
    allow(sg_app, 9000, source_sg=sg_web, note="voip gateway from nginx")
    # 8001(ai-api)은 열지 않는다. 같은 호스트 컨테이너끼리 도커 네트워크로 통한다.
    allow(sg_db, 5432, source_sg=sg_app, note="postgres from app")

    # ── S3 Gateway Endpoint (무료) ───────────────────────────────────────
    # 이게 없으면 프라이빗 서브넷에서 S3로 가는 트래픽이 NAT를 타서 데이터 요금이
    # 붙는다. 배포마다 RAG 자산 200MB를 받고 첨부파일이 계속 오간다.
    existing = ec2.describe_vpc_endpoints(Filters=[
        {"Name": "vpc-id", "Values": [vpc_id]},
        {"Name": "service-name", "Values": [f"com.amazonaws.{REGION}.s3"]},
    ])["VpcEndpoints"]
    if existing:
        ep_id = existing[0]["VpcEndpointId"]
        print(f"  이미 있음  S3 Endpoint {ep_id}")
    else:
        ep_id = ec2.create_vpc_endpoint(
            VpcId=vpc_id,
            ServiceName=f"com.amazonaws.{REGION}.s3",
            RouteTableIds=[rt_private],
            TagSpecifications=tags(f"{PROJECT}-s3-endpoint", "vpc-endpoint"),
        )["VpcEndpoint"]["VpcEndpointId"]
        print(f"  생성      S3 Endpoint {ep_id}  (무료)")
    state["s3_endpoint"] = ep_id

    save_state(state)
    print(f"\n완료. 만든 것을 {STATE_PATH} 에 기록했다.")
    print("여기까지는 전부 무료다. NAT Gateway·EC2는 아직 만들지 않았다.")


if __name__ == "__main__":
    main()
