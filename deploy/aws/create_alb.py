# ALB + 타깃 그룹만 만든다. DNS/nginx/Twilio/sg-web은 건드리지 않는다.
# 만들어만 두고 전환은 발표 후에 한다(사용자 확인, 2026-08-25).
import io, json, os, time, boto3
from botocore.exceptions import ClientError

ENV = r"c:\big-project\deploy\aws\deploy.env.local"
for line in io.open(ENV, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        if k.startswith("AWS_"):
            os.environ[k] = v.strip().strip('"').strip("'")

REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
sess = boto3.Session(region_name=REGION)
ec2, elb = sess.client("ec2"), sess.client("elbv2")
st = json.load(io.open(r"c:\big-project\deploy\aws\state.json", encoding="utf-8"))

VPC = st["vpc_id"]
SUB_A, SUB_C = st["subnets"]["public-a"], st["subnets"]["public-c"]
WEB = st["instances"]["web"]
TAGS = [{"Key": "Project", "Value": "bigproject"},
        {"Key": "ManagedBy", "Value": "create_alb.py"}]
log = []

def say(m):
    log.append(m); print(m, flush=True)

# 1) ALB 전용 보안그룹 --------------------------------------------------
name = "bigproject-alb-sg"
found = ec2.describe_security_groups(Filters=[
    {"Name": "group-name", "Values": [name]}, {"Name": "vpc-id", "Values": [VPC]}])["SecurityGroups"]
if found:
    alb_sg = found[0]["GroupId"]; say(f"[유지] 보안그룹 {name} = {alb_sg}")
else:
    alb_sg = ec2.create_security_group(GroupName=name, VpcId=VPC,
        Description="ALB inbound 80/443 from internet",
        TagSpecifications=[{"ResourceType": "security-group", "Tags": TAGS}])["GroupId"]
    ec2.authorize_security_group_ingress(GroupId=alb_sg, IpPermissions=[
        {"IpProtocol": "tcp", "FromPort": p, "ToPort": p,
         "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "public"}]} for p in (80, 443)])
    say(f"[생성] 보안그룹 {name} = {alb_sg}  (80/443 인바운드)")

# 2) 타깃 그룹 ----------------------------------------------------------
tg_name = "bigproject-web-tg"
try:
    tg = elb.describe_target_groups(Names=[tg_name])["TargetGroups"][0]
    tg_arn = tg["TargetGroupArn"]; say(f"[유지] 타깃그룹 {tg_name}")
except ClientError:
    tg_arn = elb.create_target_group(
        Name=tg_name, Protocol="HTTP", Port=80, VpcId=VPC, TargetType="instance",
        # nginx가 :80에서 200을 돌려주는 유일한 경로. 나머지는 전부 301이라
        # 헬스체크가 https로 따라가서 실패한다(nginx.conf.template:49-52 주석 참고).
        HealthCheckProtocol="HTTP", HealthCheckPath="/healthz",
        HealthCheckIntervalSeconds=30, HealthCheckTimeoutSeconds=5,
        HealthyThresholdCount=2, UnhealthyThresholdCount=3,
        Matcher={"HttpCode": "200"}, Tags=TAGS)["TargetGroups"][0]["TargetGroupArn"]
    say(f"[생성] 타깃그룹 {tg_name}  (헬스체크 GET /healthz)")

health = elb.describe_target_health(TargetGroupArn=tg_arn)["TargetHealthDescriptions"]
if not any(t["Target"]["Id"] == WEB for t in health):
    elb.register_targets(TargetGroupArn=tg_arn, Targets=[{"Id": WEB, "Port": 80}])
    say(f"[등록] 웹 서버 {WEB}:80")

# 3) ALB ----------------------------------------------------------------
lb_name = "bigproject-alb"
try:
    lb = elb.describe_load_balancers(Names=[lb_name])["LoadBalancers"][0]
    say(f"[유지] ALB {lb_name}")
except ClientError:
    lb = elb.create_load_balancer(Name=lb_name, Subnets=[SUB_A, SUB_C],
        SecurityGroups=[alb_sg], Scheme="internet-facing", Type="application",
        IpAddressType="ipv4", Tags=TAGS)["LoadBalancers"][0]
    say(f"[생성] ALB {lb_name}  (public-a + public-c)")
lb_arn, lb_dns = lb["LoadBalancerArn"], lb["DNSName"]

# 유휴 타임아웃. 기본 60초로 두면 AI 분석(nginx 1200s)이 잘리고
# 녹음 WebSocket(nginx 3600s)이 끊긴다. ALB 최대치가 4000초다.
elb.modify_load_balancer_attributes(LoadBalancerArn=lb_arn, Attributes=[
    {"Key": "idle_timeout.timeout_seconds", "Value": "4000"}])
say("[설정] 유휴 타임아웃 4000초 (분석 1200s·녹음 3600s 수용)")

# 4) 리스너 :80 ---------------------------------------------------------
ls = elb.describe_listeners(LoadBalancerArn=lb_arn)["Listeners"]
if not any(l["Port"] == 80 for l in ls):
    elb.create_listener(LoadBalancerArn=lb_arn, Protocol="HTTP", Port=80,
        DefaultActions=[{"Type": "forward", "TargetGroupArn": tg_arn}])
    say("[생성] 리스너 HTTP:80 -> 타깃그룹")
else:
    say("[유지] 리스너 HTTP:80")

say(f"\nALB DNS = {lb_dns}")
io.open(r"C:\Users\User\AppData\Local\Temp\claude\c--big-project\eba721a0-1847-443f-ac2e-d78d9e169a29\scratchpad\alb_out.txt",
        "w", encoding="utf-8").write("\n".join(log) + f"\nTG_ARN={tg_arn}\nLB_ARN={lb_arn}\nLB_DNS={lb_dns}\nALB_SG={alb_sg}\n")
