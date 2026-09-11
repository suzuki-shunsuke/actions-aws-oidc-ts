# actions-aws-oidc-ts

[![JSR](https://jsr.io/badges/@suzuki-shunsuke/actions-aws-oidc)](https://jsr.io/@suzuki-shunsuke/actions-aws-oidc)

actions-aws-oidc-ts is a JSR package to get AWS credentials on GitHub Actions by
assuming an IAM role with the GitHub OIDC token.

It's for GitHub Actions written in JavaScript or TypeScript, which would
otherwise ask their users to run
[aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials)
first.

## Why

`aws-actions/configure-aws-credentials` either exports the credentials as
environment variables or writes them to `~/.aws/credentials` as a profile.
Either way every later step of the job can read them.

Assuming the role inside your action instead keeps the credentials in its own
process, where nothing else in the job can reach them. The session also defaults
to 900 seconds, the shortest AWS STS accepts, because an action normally only
needs it for a few API calls.

It saves your users a step too. GitHub Actions downloads each action separately,
so one action fewer is one download fewer.

Only the STS `AssumeRoleWithWebIdentity` API is called, and that call carries no
signature because the GitHub OIDC token is what authenticates it. So this
package has no dependencies, which matters when an action is bundled and every
job downloads it.

## Example

```ts
import { credentials } from "@suzuki-shunsuke/actions-aws-oidc";

const provider = credentials({
  roleArn: "arn:aws:iam::123456789012:role/example",
});
const { accessKeyId, secretAccessKey, sessionToken } = await provider();
```

`credentials` returns a function, and nothing happens until you call it. Every
call reads a fresh OIDC token and assumes the role again, so a token is never
reused past its own lifetime and an expired session is never handed out.

It fits
[@suzuki-shunsuke/github-app-jwt-aws-kms](https://jsr.io/@suzuki-shunsuke/github-app-jwt-aws-kms)'s
`credentials` input directly.

```ts
import { createJwt } from "@suzuki-shunsuke/github-app-jwt-aws-kms";

const sign = createJwt({
  keyId: "arn:aws:kms:us-east-1:123456789012:key/...",
  credentials: credentials({
    roleArn: "arn:aws:iam::123456789012:role/example",
  }),
});
```

An AWS SDK client takes it with a small wrapper, since the SDK passes its own
argument to a provider.

```ts
import { KMSClient } from "@aws-sdk/client-kms";

const provider = credentials({ roleArn: "..." });
const client = new KMSClient({ credentials: () => provider() });
```

The job needs the permission `id-token: write`.

```yaml
permissions:
  id-token: write
```

## Options

```ts
export type Inputs = {
  roleArn: string;
  durationSeconds?: number; // 900
  roleSessionName?: string; // "GitHubActions"
  audience?: string; // "sts.amazonaws.com"
  region?: string; // the global endpoint
  endpoint?: string; // overrides region
  getIdToken?: GetIdToken;
};
```

The STS global endpoint `sts.amazonaws.com` is called by default, which works
from anywhere in the `aws` partition. Set `region` for a regional endpoint,
which is closer and keeps working when the global one doesn't, or `endpoint` for
another partition such as `https://sts.cn-north-1.amazonaws.com.cn/`.

This package covers assuming a role with OIDC and nothing else. If you need any
of the other options `aws-actions/configure-aws-credentials` offers, such as an
external ID or a session policy, let your users run that action and read the
credentials it exports instead.

`roleSessionName` defaults to `GitHubActions`, which is what
`aws-actions/configure-aws-credentials` uses, so CloudTrail stays readable and
an IAM trust policy conditioning on `sts:RoleSessionName` keeps working. The AWS
SDK would otherwise default to a name ending in a timestamp.

`getIdToken` is there so that you can pass a stub in tests. By default the token
is read from the GitHub Actions runtime and masked with `::add-mask::`, so it
doesn't appear in the workflow log. The secret access key and the session token
are masked the same way.

## Permissions

Deno needs `--allow-net` to reach GitHub and AWS STS, and `--allow-env` to read
the OIDC environment variables GitHub Actions sets.
