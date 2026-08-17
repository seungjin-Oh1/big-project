"""유료 자원을 만든다. 여기서부터 시간당 요금이 붙는다.

create_network.py가 만든 무료 구조 위에 얹는다. state.json을 읽어 서브넷과
보안그룹 ID를 가져오므로 네트워크를 먼저 만들어야 한다.

무엇을 만드나
    탄력적 IP + NAT Gateway   public-a. 프라이빗에서 바깥으로 나가는 유일한 길
    프라이빗 라우팅 0.0.0.0/0 -> NAT
    SSH 규칙                  sg-web <- 내 공인 IP,  sg-app <- sg-web (경유 접속)
    RDS 서브넷 그룹 + RDS      private-db-a/c, db.t3.small, PostgreSQL 16
    EC2 nginx                 public-a, t3.small
    EC2 앱 서버                private-app-a, t3.xlarge (이미지 4개가 12GB쯤 된다)

왜 스크립트로 하나
    콘솔에서 클릭으로 만들면 무엇을 만들었는지 기억에만 남는다. NAT 하나를
    빠뜨리면 월 35달러가 계속 나간다. 만든 것의 ID를 state.json에 적고
    teardown.py가 그 파일만 보고 역순으로 지운다.

여러 번 돌려도 안전하다 - 이름표로 이미 있는지 보고 건너뛴다.

실행:
    python deploy/aws/create_compute.py          무엇을 만들지 보여주고 묻는다
    python deploy/aws/create_compute.py --yes    묻지 않는다
"""

import json
import os
import secrets
import sys
import urllib.request

import boto3
from botocore.exceptions import ClientError
from dotenv import dotenv_values

# 윈도우 콘솔은 기본이 cp949라 이 파일이 쓰는 em-dash(—)에서 UnicodeEncodeError로
# 죽는다. 실제로 겪었다 - 자원을 만들기 직전 줄에서 멈춰서, 아무것도 안 만들어진 채
# 스크립트만 끝났다. 만들다 만 상태였다면 지우는 것부터 손으로 해야 했다.
# 출력 인코딩 때문에 배포가 멈추는 일은 없어야 한다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT = "bigproject"
REGION = "ap-northeast-2"

# 앱 서버는 이미지 3개를 받고 컨테이너를 동시에 돌린다. ai-api 혼자 임베딩
# 모델을 메모리에 올리므로 2GB로는 못 버틴다.
#
# 이 계정은 프리 플랜이라 아무 크기나 못 쓴다(t3.xlarge는 거부당했다).
# free-tier-eligible 중 가장 큰 것이 m7i-flex.large(2 vCPU / 8GB)이고
# x86_64라 우리 이미지(amd64)와 맞는다. t4g 계열은 arm64라 쓸 수 없다.
APP_INSTANCE = "m7i-flex.large"
APP_DISK_GB = 60
WEB_INSTANCE = "t3.small"
WEB_DISK_GB = 20
# 이 계정은 프리 플랜이라 db.t3.small은 FreeTierRestrictionError로 막힌다.
# micro는 허용된다. 상담 데이터 몇 건 넣어보는 용도라 성능은 문제가 안 된다.
DB_INSTANCE = "db.t3.micro"
DB_DISK_GB = 20

# 시간당 요금(서울 리전, 온디맨드 기준). 만들기 전에 보여주려고 적어 둔다.
HOURLY = {
    "NAT Gateway": 0.059,
    f"EC2 {APP_INSTANCE}": 0.1008,
    f"EC2 {WEB_INSTANCE}": 0.0260,
    f"RDS {DB_INSTANCE}": 0.0210,
    "EBS 100GB": 0.0130,
}

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
KEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"{PROJECT}-key.pem")

# 도커와 compose 플러그인만 깔아 둔다. 레포를 받고 컨테이너를 띄우는 것은
# 사람이 확인하면서 해야 하므로 여기서 하지 않는다.
USER_DATA = """#!/bin/bash
set -eux
dnf update -y
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user
mkdir -p /usr/local/lib/docker/cli-plugins
curl -sSL https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
echo "bootstrap done" > /var/log/bigproject-bootstrap.done
"""


def load_state():
    if not os.path.exists(STATE_PATH):
        sys.exit("state.json이 없습니다. create_network.py를 먼저 돌리세요.")
    with open(STATE_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def session():
    cfg = dotenv_values(r"C:\big-project\backend\ai-api\.env")
    if not cfg.get("AWS_ACCESS_KEY_ID"):
        sys.exit("AWS_ACCESS_KEY_ID를 찾지 못했습니다.")
    return boto3.session.Session(
        aws_access_key_id=cfg["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=cfg["AWS_SECRET_ACCESS_KEY"],
        region_name=REGION,
    )


def tags(name, kind):
    return [{"ResourceType": kind, "Tags": [
        {"Key": "Name", "Value": name},
        {"Key": "Project", "Value": PROJECT},
    ]}]


def my_ip():
    """SSH를 내 주소에서만 열려고 공인 IP를 알아낸다."""
    with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=10) as r:
        return r.read().decode().strip()


def latest_al2023(ec2):
    """AMI ID를 하드코딩하지 않는다. 리전마다 다르고 주기적으로 바뀐다.

    보통 SSM 공개 파라미터(/aws/service/ami-amazon-linux-latest/...)로 받아오는데
    그러려면 ssm:GetParameter가 필요하다. 이 계정에는 없어서 이미지 목록에서
    직접 최신을 고른다. ec2:DescribeImages만 있으면 된다.
    """
    images = ec2.describe_images(
        Owners=["amazon"],
        Filters=[
            {"Name": "name", "Values": ["al2023-ami-2023*-kernel-6.1-x86_64"]},
            {"Name": "state", "Values": ["available"]},
            {"Name": "architecture", "Values": ["x86_64"]},
        ],
    )["Images"]
    if not images:
        sys.exit("Amazon Linux 2023 AMI를 찾지 못했습니다.")
    images.sort(key=lambda i: i["CreationDate"], reverse=True)
    return images[0]["ImageId"]


def latest_postgres16(rds):
    """PostgreSQL 16의 최신 마이너 버전을 고른다.

    버전을 고정해 두면 AWS가 그 마이너를 내리는 순간 생성이 실패한다(실제로
    16.6이 이미 없어졌다). 문자열 정렬로는 16.9가 16.14보다 뒤로 가므로
    숫자로 비교한다.
    """
    versions = [v["EngineVersion"] for v in
                rds.describe_db_engine_versions(Engine="postgres")["DBEngineVersions"]
                if v["EngineVersion"].startswith("16.")]
    if not versions:
        sys.exit("PostgreSQL 16 계열을 찾지 못했습니다.")
    return max(versions, key=lambda v: [int(x) for x in v.split(".")])


def find_by_name(ec2, describe, key, name):
    items = getattr(ec2, describe)(
        Filters=[{"Name": "tag:Name", "Values": [name]}])[key]
    return items[0] if items else None


def confirm():
    total = sum(HOURLY.values())
    print("\n만들 것과 시간당 요금")
    for k, v in HOURLY.items():
        print(f"    {k:22} ${v:.4f}")
    print(f"    {'합계':22} ${total:.4f}  (하루 ${total*24:.2f})")
    print("\n  NAT Gateway는 중지가 없다. 끝나면 teardown.py로 삭제해야 한다.")
    if "--yes" in sys.argv:
        return
    if input("\n계속할까요? (yes 입력) ").strip().lower() != "yes":
        sys.exit("취소했습니다. 아무것도 만들지 않았습니다.")


def main():
    confirm()

    s = session()
    ec2 = s.client("ec2")
    rds = s.client("rds")
    state = load_state()

    vpc_id = state["vpc_id"]
    subnets = state["subnets"]
    sg = state["security_groups"]

    # ── SSH 규칙 ─────────────────────────────────────────────────────────
    # 앱 서버는 프라이빗이라 인터넷에서 직접 못 들어간다. nginx 서버를 밟고
    # 들어가야 하므로 sg-app의 22번 소스를 sg-web으로 준다.
    ip = my_ip()
    print(f"\n내 공인 IP {ip} — SSH를 이 주소에서만 연다")

    def allow(gid, port, source_sg=None, cidr=None, note=""):
        perm = {"IpProtocol": "tcp", "FromPort": port, "ToPort": port}
        if source_sg:
            perm["UserIdGroupPairs"] = [{"GroupId": source_sg, "Description": note}]
        else:
            perm["IpRanges"] = [{"CidrIp": cidr, "Description": note}]
        try:
            ec2.authorize_security_group_ingress(GroupId=gid, IpPermissions=[perm])
            print(f"  규칙      {gid} <- {port} from {source_sg or cidr}")
        except ClientError as e:
            if e.response["Error"]["Code"] != "InvalidPermission.Duplicate":
                raise

    # 설명은 ASCII만 받는다(AWS 제약).
    allow(sg["web"], 22, cidr=f"{ip}/32", note="ssh from operator")
    allow(sg["app"], 22, source_sg=sg["web"], note="ssh via bastion")

    # ── 키 페어 ──────────────────────────────────────────────────────────
    key_name = f"{PROJECT}-key"
    existing = ec2.describe_key_pairs(
        Filters=[{"Name": "key-name", "Values": [key_name]}])["KeyPairs"]
    if existing:
        print(f"  이미 있음  키페어 {key_name}")
        if not os.path.exists(KEY_PATH):
            print("  !! .pem 파일이 없습니다. 콘솔에서 키페어를 지우고 다시 돌리세요.")
    else:
        material = ec2.create_key_pair(
            KeyName=key_name, TagSpecifications=tags(key_name, "key-pair"),
        )["KeyMaterial"]
        # 개인키다. 저장소에 들어가면 안 된다(.gitignore에 넣어 두었다).
        with open(KEY_PATH, "w", encoding="utf-8", newline="\n") as f:
            f.write(material)
        os.chmod(KEY_PATH, 0o600)
        print(f"  생성      키페어 {key_name} -> {KEY_PATH}")
    state["key_name"] = key_name

    # ── NAT Gateway ──────────────────────────────────────────────────────
    if state.get("nat_id"):
        print(f"  이미 있음  NAT {state['nat_id']}")
    else:
        eip = ec2.allocate_address(
            Domain="vpc", TagSpecifications=tags(f"{PROJECT}-nat-eip", "elastic-ip"))
        state["eip_alloc_id"] = eip["AllocationId"]
        print(f"  생성      탄력적 IP {eip['PublicIp']}")

        nat = ec2.create_nat_gateway(
            SubnetId=subnets["public-a"],
            AllocationId=eip["AllocationId"],
            TagSpecifications=tags(f"{PROJECT}-nat", "natgateway"),
        )["NatGateway"]
        state["nat_id"] = nat["NatGatewayId"]
        save_state(state)  # 여기서부터 과금이라 먼저 적어 둔다
        print(f"  생성      NAT {nat['NatGatewayId']} — 준비될 때까지 2분쯤 걸린다")
        ec2.get_waiter("nat_gateway_available").wait(NatGatewayIds=[nat["NatGatewayId"]])
        print("  준비됨    NAT")

    # 프라이빗 라우팅에 기본 경로를 붙인다. 이게 없으면 앱 서버가 OpenAI도
    # Modal도 못 부르고, 도커 이미지도 못 받는다.
    try:
        ec2.create_route(RouteTableId=state["rt_private"],
                         DestinationCidrBlock="0.0.0.0/0",
                         NatGatewayId=state["nat_id"])
        print("  라우팅    프라이빗 0.0.0.0/0 -> NAT")
    except ClientError as e:
        if e.response["Error"]["Code"] != "RouteAlreadyExists":
            raise
        print("  이미 있음  프라이빗 기본 경로")

    # ── RDS ──────────────────────────────────────────────────────────────
    group_name = f"{PROJECT}-db-subnet-group"
    try:
        rds.create_db_subnet_group(
            DBSubnetGroupName=group_name,
            # 서브넷 그룹은 서로 다른 AZ 2개를 강제한다. Single-AZ로 띄워도 그렇다.
            DBSubnetGroupDescription="private db subnets for bigproject",
            SubnetIds=[subnets["private-db-a"], subnets["private-db-c"]],
        )
        print(f"  생성      DB 서브넷 그룹 {group_name}")
    except ClientError as e:
        if e.response["Error"]["Code"] != "DBSubnetGroupAlreadyExists":
            raise
        print(f"  이미 있음  DB 서브넷 그룹 {group_name}")

    db_id = f"{PROJECT}-db"
    try:
        rds.describe_db_instances(DBInstanceIdentifier=db_id)
        print(f"  이미 있음  RDS {db_id}")
    except ClientError as e:
        if e.response["Error"]["Code"] != "DBInstanceNotFound":
            raise
        password = secrets.token_urlsafe(24).replace("-", "x").replace("_", "y")
        engine_version = latest_postgres16(rds)
        print(f"  PostgreSQL {engine_version}")
        rds.create_db_instance(
            DBInstanceIdentifier=db_id,
            DBName="bigproject",
            Engine="postgres",
            EngineVersion=engine_version,
            DBInstanceClass=DB_INSTANCE,
            AllocatedStorage=DB_DISK_GB,
            StorageType="gp3",
            MasterUsername="postgres",
            MasterUserPassword=password,
            DBSubnetGroupName=group_name,
            VpcSecurityGroupIds=[sg["db"]],
            # 인터넷에서 직접 닿으면 안 된다. sg-db가 sg-app만 허용하지만
            # 이 값이 True면 공인 주소가 붙어 통제가 한 겹 얇아진다.
            PubliclyAccessible=False,
            MultiAZ=False,
            # 어차피 확인하고 지울 것이다. 백업을 켜면 스냅샷도 과금된다.
            BackupRetentionPeriod=0,
            DeletionProtection=False,
            Tags=[{"Key": "Project", "Value": PROJECT}],
        )
        state["db_id"] = db_id
        state["db_password"] = password  # state.json은 gitignore 대상이다
        save_state(state)
        print(f"  생성      RDS {db_id} — 10분쯤 걸린다. EC2를 먼저 만든다")

    # ── EC2 ──────────────────────────────────────────────────────────────
    ami = latest_al2023(ec2)
    print(f"\n  AMI {ami} (Amazon Linux 2023)")

    def ensure_instance(name, itype, subnet_id, sg_id, disk_gb, public):
        full = f"{PROJECT}-{name}"
        found = ec2.describe_instances(Filters=[
            {"Name": "tag:Name", "Values": [full]},
            {"Name": "instance-state-name", "Values": ["pending", "running", "stopped"]},
        ])["Reservations"]
        if found:
            iid = found[0]["Instances"][0]["InstanceId"]
            print(f"  이미 있음  EC2 {full:20} {iid}")
            return iid
        resp = ec2.run_instances(
            ImageId=ami, InstanceType=itype, MinCount=1, MaxCount=1,
            KeyName=key_name,
            NetworkInterfaces=[{
                "DeviceIndex": 0,
                "SubnetId": subnet_id,
                "Groups": [sg_id],
                # 프라이빗 서브넷 인스턴스에 공인 IP를 붙이면 설계가 무너진다.
                "AssociatePublicIpAddress": public,
            }],
            BlockDeviceMappings=[{
                "DeviceName": "/dev/xvda",
                "Ebs": {"VolumeSize": disk_gb, "VolumeType": "gp3",
                        # 인스턴스를 지울 때 볼륨도 같이 지운다. 안 그러면
                        # terminate 후에도 EBS 요금이 계속 나간다.
                        "DeleteOnTermination": True},
            }],
            UserData=USER_DATA,
            TagSpecifications=tags(full, "instance"),
        )
        iid = resp["Instances"][0]["InstanceId"]
        print(f"  생성      EC2 {full:20} {iid}  {itype}  {disk_gb}GB")
        return iid

    instances = state.get("instances", {})
    instances["web"] = ensure_instance("web", WEB_INSTANCE, subnets["public-a"],
                                       sg["web"], WEB_DISK_GB, public=True)
    instances["app"] = ensure_instance("app", APP_INSTANCE, subnets["private-app-a"],
                                       sg["app"], APP_DISK_GB, public=False)
    state["instances"] = instances
    save_state(state)

    print("\n  인스턴스가 뜰 때까지 기다립니다...")
    ec2.get_waiter("instance_running").wait(InstanceIds=list(instances.values()))

    desc = ec2.describe_instances(InstanceIds=list(instances.values()))
    addr = {}
    for r in desc["Reservations"]:
        for i in r["Instances"]:
            name = next(t["Value"] for t in i["Tags"] if t["Key"] == "Name")
            addr[name] = (i.get("PublicIpAddress"), i["PrivateIpAddress"])
    state["addresses"] = addr
    save_state(state)

    print("\n주소")
    for name, (pub, priv) in addr.items():
        print(f"    {name:20} 공인 {pub or '-':16} 사설 {priv}")

    web_ip = addr.get(f"{PROJECT}-web", (None, None))[0]
    print(f"\n접속")
    print(f"    nginx 서버   ssh -i {KEY_PATH} ec2-user@{web_ip}")
    print(f"    앱 서버      nginx를 밟고 들어간다 (ProxyJump)")
    print(f"                 ssh -i {KEY_PATH} -J ec2-user@{web_ip} "
          f"ec2-user@{addr.get(f'{PROJECT}-app', (None,'?'))[1]}")

    print("\nRDS 준비 상태는 따로 확인한다:")
    print("    python deploy/aws/create_compute.py --wait-db")
    print(f"\n만든 것을 {STATE_PATH}에 적었다. 끝나면 teardown.py로 지울 것.")


def wait_db():
    s = session()
    rds = s.client("rds")
    state = load_state()
    db_id = state.get("db_id")
    if not db_id:
        sys.exit("아직 RDS를 만들지 않았습니다.")
    print(f"{db_id} 준비를 기다립니다...")
    rds.get_waiter("db_instance_available").wait(DBInstanceIdentifier=db_id)
    d = rds.describe_db_instances(DBInstanceIdentifier=db_id)["DBInstances"][0]
    ep = d["Endpoint"]
    state["db_endpoint"] = ep["Address"]
    save_state(state)
    print(f"준비됨  {ep['Address']}:{ep['Port']}")
    print("\ncore-api에 넣을 값 (앱 서버 .env):")
    print(f"    DB_URL=jdbc:postgresql://{ep['Address']}:{ep['Port']}/bigproject")
    print(f"    DB_USERNAME=postgres")
    print(f"    DB_PASSWORD={state['db_password']}")


if __name__ == "__main__":
    if "--wait-db" in sys.argv:
        wait_db()
    else:
        main()
