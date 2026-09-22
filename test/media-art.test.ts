import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MediaArtStack } from '../lib/media-art-stack';

// 렌더 루프의 단위 테스트는 만들지 않는다(스펙 7). 여기서 고정하는 것은 배포 불변식이다 —
// 하나라도 조용히 뒤집히면 사이트가 공개되거나, 검은 화면이 되거나, OAC 가 OAI 로 퇴행한다.

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  template = Template.fromStack(new MediaArtStack(app, 'TestStack'));
});

describe('버킷', () => {
  test('퍼블릭 접근이 네 항목 모두 차단된다', () => {
    // blockPublicAccess prop 을 빼면 이 속성이 템플릿에 아예 렌더되지 않는다.
    // cdk.json 의 publicAccessBlockedByDefault 플래그는 이미 전달한 객체의 미지정 하위
    // 필드만 채우므로, 플래그에 의존하면 이 테스트가 잡아준다.
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('removalPolicy DESTROY + autoDeleteObjects', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  test('버킷 정책이 CloudFront 서비스 주체에게만 SourceArn 조건으로 GetObject 를 준다', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    });
  });
});

describe('배포', () => {
  test('OAC 를 쓰고 OAI 로 퇴행하지 않는다', () => {
    // origins.S3Origin 은 @deprecated 인데도 타입 검사를 통과하면서 조용히 OAI 를 쓴다.
    // 그 퇴행은 synth 경고 한 줄로만 드러나므로 여기서 못박는다.
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
    expect(Object.keys(template.findResources('AWS::CloudFront::CloudFrontOriginAccessIdentity')))
      .toHaveLength(0);
  });

  test('index.html 을 루트 객체로, HTTPS 리다이렉트, 압축 켜기', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          Compress: true,
        }),
      }),
    });
  });

  test('404 를 index.html 로 돌리지 않는다 — SPA 가 아니다', () => {
    // 이걸 넣으면 모듈 경로가 틀렸을 때 브라우저가 JS 대신 HTML 을 200 으로 받아
    // "Unexpected token '<'" 라는 엉뚱한 오류를 내거나 조용한 검은 화면이 된다.
    const dists = template.findResources('AWS::CloudFront::Distribution');
    for (const r of Object.values(dists)) {
      expect((r as any).Properties.DistributionConfig.CustomErrorResponses).toBeUndefined();
    }
  });
});

describe('업로드', () => {
  test('배포마다 /* 를 무효화하고 낡은 파일을 정리한다', () => {
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DistributionPaths: ['/*'],
      DistributionId: Match.anyValue(),
      Prune: true,
    });
  });

  test('retainOnDelete 를 false 로 덮지 않는다 — autoDeleteObjects 와 경쟁한다', () => {
    const crs = template.findResources('Custom::CDKBucketDeployment');
    for (const r of Object.values(crs)) {
      expect((r as any).Properties.RetainOnDelete).toBeUndefined();
    }
  });
});

describe('출력', () => {
  test('전시 URL 을 뱉는다', () => {
    const outputs = template.findOutputs('*');
    expect(Object.keys(outputs)).toContain('ExhibitionUrl');
  });
});
