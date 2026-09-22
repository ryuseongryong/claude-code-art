import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

/**
 * Generative Hours — 정적 전시 사이트를 S3 + CloudFront(OAC)로 배포한다.
 *
 * 빌드 단계가 없다. site/ 의 파일이 그대로 올라간다.
 */
export class MediaArtStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 버킷 ──────────────────────────────────────────────────────────────
    // blockPublicAccess 를 반드시 명시한다. cdk.json 의
    // @aws-cdk/aws-s3:publicAccessBlockedByDefault 플래그는 이미 전달한 객체의 미지정
    // 하위 필드만 채운다(setDefaultPublicAccessBlockConfig). prop 이 아예 없으면 템플릿에
    // PublicAccessBlockConfiguration 이 렌더되지 않고 S3 계정 기본값에 의존하게 된다 —
    // 실측으로 이 줄만 빼고 synth 하니 해당 속성이 undefined 였다.
    const bucket = new s3.Bucket(this, 'ExhibitionBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 둘은 함께여야 한다. removalPolicy 를 RETAIN 으로 두면 synth 가
      // CannotAutoDeleteObjectsProperty 로 실패한다.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── 배포 ──────────────────────────────────────────────────────────────
    // S3BucketOrigin.withOriginAccessControl 이어야 한다. 구식 origins.S3Origin 은
    // @deprecated 인데도 타입 검사를 통과하면서 조용히 OAC 대신 OAI 를 쓴다 — 템플릿이
    // CloudFrontOriginAccessIdentity + Principal.CanonicalUser 가 되어 스펙 위반이고,
    // synth 때 경고 한 줄만 나온다. 이 헬퍼는 버킷 정책 statement
    // (s3:GetObject + AWS:SourceArn 조건)를 자동으로 추가하므로 수동 grant 가 필요 없다.
    const distribution = new cloudfront.Distribution(this, 'ExhibitionCdn', {
      comment: 'Generative Hours — 제너러티브 아트 전시',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
          originAccessLevels: [cloudfront.AccessLevel.READ],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,

      // errorResponses 를 두지 않는다. 이건 SPA 가 아니다.
      // 404 를 index.html 로 돌리면 모듈 경로가 틀렸을 때 브라우저가 JS 대신 HTML 을
      // 200 으로 받아 "Unexpected token '<'" 라는 엉뚱한 오류를 내거나 조용한 검은
      // 화면이 된다. 요청이 실패한 게 그대로 보여야 한다.
    });

    // ── 업로드 ────────────────────────────────────────────────────────────
    // Docker 가 필요 없다. AwsCliLayer 는 prebuilt zip("packaging": "file")이고
    // 사이트와 핸들러는 순수 JS 로 zip 되는 디렉터리 복사다. Docker 는 Source.asset() 에
    // bundling 을 넘길 때만 필요하고 이 사이트는 필요 없다 — Docker 없는 머신에서
    // cdk synth EXIT=0 을 확인했다.
    //
    // site/package.json({"type":"module"})도 함께 올라간다. exclude 로 숨기지 않는 이유는
    // 스펙 1 의 "같은 파일이 그대로 S3 에 올라간다" 를 지키기 위해서다 — 18바이트이고
    // 내용은 {"type":"module"} 뿐이라 아무것도 노출하지 않는다.
    //
    // retainOnDelete 는 건드리지 않는다(기본 true). false 로 바꾸면 stack 해체 시
    // Custom::S3AutoDeleteObjects 와 경쟁해 간헐적 DELETE_FAILED 의 원인이 된다.
    // 기본 prune:true 가 aws s3 sync --delete 로 낡은 파일을 처리한다.
    new s3deploy.BucketDeployment(this, 'DeployExhibition', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'site'))],
      destinationBucket: bucket,
      distribution,
      // 배포마다 전체 무효화. 전시 사이트는 파일이 적고 방문이 드물어 비용보다 정확성이 낫다.
      distributionPaths: ['/*'],
      memoryLimit: 256,
    });

    // ── 출력 ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ExhibitionUrl', {
      value: `https://${distribution.distributionDomainName}/`,
      description: '전시 URL',
    });
    new cdk.CfnOutput(this, 'ExhibitionBucketName', {
      value: bucket.bucketName,
      description: '작품 파일이 올라가는 버킷 (퍼블릭 접근 전면 차단, CloudFront 만 OAC 로 읽는다)',
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront 배포 ID',
    });
  }
}
