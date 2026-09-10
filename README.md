# actions-aws-oidc-ts

[![JSR](https://jsr.io/badges/@suzuki-shunsuke/actions-aws-oidc)](https://jsr.io/@suzuki-shunsuke/actions-aws-oidc)
[![License](http://img.shields.io/badge/license-mit-blue.svg?style=flat-square)](https://raw.githubusercontent.com/suzuki-shunsuke/actions-aws-oidc-ts/main/LICENSE)

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

## Example

```ts
import { KMSClient } from "@aws-sdk/client-kms";
import { credentials } from "@suzuki-shunsuke/actions-aws-oidc";

const client = new KMSClient({
  credentials: credentials({
    roleArn: "arn:aws:iam::123456789012:role/example",
  }),
});
```

`credentials` returns an AWS credential provider, which every AWS SDK client
accepts. The OIDC token is read only when the credentials are actually needed,
and again whenever the AWS SDK finds them expired, so a token is never reused
past its own lifetime.

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
  getIdToken?: GetIdToken;
};
```

This package covers assuming a role with OIDC and nothing else. If you need any
of the other options `aws-actions/configure-aws-credentials` offers, such as an
external ID, a session policy or a custom STS endpoint, let your users run that
action and use the standard AWS credential chain instead, by leaving
`credentials` out.

`getIdToken` is there so that you can pass a stub in tests. By default the token
is read from the GitHub Actions runtime and masked with `::add-mask::`, so it
doesn't appear in the workflow log.

## LICENSE

[MIT](LICENSE)
