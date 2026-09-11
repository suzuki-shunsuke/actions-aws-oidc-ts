/**
 * This module gets AWS credentials on GitHub Actions by assuming an IAM role
 * with the GitHub OIDC token.
 *
 * Unlike aws-actions/configure-aws-credentials, the credentials are not
 * exported as environment variables and are not written to ~/.aws/credentials,
 * so they stay inside the action asking for them and later steps of the job
 * can't see them.
 *
 * Only the STS AssumeRoleWithWebIdentity API is called, and that call carries
 * no signature because the GitHub OIDC token is what authenticates it. So the
 * AWS SDK isn't needed, which matters in a GitHub Action: the action is bundled
 * and every job downloads it.
 *
 * @example
 * ```ts
 * import { credentials } from "@suzuki-shunsuke/actions-aws-oidc";
 *
 * const provider = credentials({
 *   roleArn: "arn:aws:iam::123456789012:role/example",
 * });
 * const { accessKeyId, secretAccessKey, sessionToken } = await provider();
 * ```
 *
 * The job needs the permission `id-token: write`.
 *
 * @module
 */

import process from "node:process";

/** Temporary AWS credentials returned by AWS STS. */
export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** When the session stops working. It's 900 seconds away by default. */
  expiration: Date;
};

/**
 * A function returning temporary AWS credentials.
 *
 * Nothing happens until it's called, and every call assumes the role again, so
 * a caller that holds on to the provider never uses a stale session.
 * @suzuki-shunsuke/github-app-jwt-aws-kms takes one of these as its credentials
 * input.
 */
export type Credentials = () => Promise<AwsCredentials>;

/** A function returning a GitHub OIDC token for the given audience. */
export type GetIdToken = (audience: string) => Promise<string>;

/** The audience AWS STS expects from the GitHub OIDC provider. */
const defaultAudience = "sts.amazonaws.com";

/**
 * The session name aws-actions/configure-aws-credentials uses.
 *
 * Matching it keeps CloudTrail readable and keeps working for anyone whose IAM
 * trust policy conditions on sts:RoleSessionName. The AWS SDK would otherwise
 * default to a name ending in a timestamp.
 */
const defaultRoleSessionName = "GitHubActions";

/**
 * The shortest session AWS STS accepts.
 *
 * A session normally only has to outlive a few API calls, so the default is the
 * minimum rather than the AWS default of an hour.
 */
const defaultDurationSeconds = 900;

/** Inputs of the credentials function. */
export type Inputs = {
  /** The ARN of the IAM role to assume. */
  roleArn: string;
  /** It defaults to 900, the shortest session AWS STS accepts. */
  durationSeconds?: number;
  /**
   * It defaults to "GitHubActions", which is what
   * aws-actions/configure-aws-credentials uses.
   */
  roleSessionName?: string;
  /** It defaults to "sts.amazonaws.com", which is what AWS STS expects. */
  audience?: string;
  /**
   * The AWS region whose STS endpoint is called.
   *
   * It defaults to the global endpoint sts.amazonaws.com, which works from
   * anywhere in the aws partition. A regional endpoint is closer and keeps
   * working when the global one doesn't.
   */
  region?: string;
  /**
   * The STS endpoint, which overrides region entirely.
   *
   * Set it for another partition, such as
   * https://sts.cn-north-1.amazonaws.com.cn.
   */
  endpoint?: string;
  /**
   * A function returning a GitHub OIDC token.
   *
   * It defaults to reading the token from the GitHub Actions runtime.
   * It's declared so that you can pass a stub in tests.
   */
  getIdToken?: GetIdToken;
};

/**
 * This function reads a GitHub OIDC token from the GitHub Actions runtime.
 *
 * It masks the token so that it doesn't appear in the workflow log, the same
 * way @actions/core's getIDToken does, but without the dependency.
 */
export const getIdToken: GetIdToken = async (
  audience: string,
): Promise<string> => {
  const url = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  if (!url) {
    throw new Error(
      "the environment variable ACTIONS_ID_TOKEN_REQUEST_URL isn't set. The job requires the permission `id-token: write`",
    );
  }
  const token = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!token) {
    throw new Error(
      "the environment variable ACTIONS_ID_TOKEN_REQUEST_TOKEN isn't set. The job requires the permission `id-token: write`",
    );
  }

  const response = await fetch(
    `${url}&audience=${encodeURIComponent(audience)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `failed to get a GitHub OIDC token: ${response.status} ${response.statusText}`,
    );
  }
  const body = await response.json();
  const idToken = body?.value;
  if (typeof idToken !== "string" || !idToken) {
    throw new Error("GitHub returned no OIDC token");
  }
  // This is the ::add-mask:: workflow command, which @actions/core's setSecret
  // writes too. Without it the token would appear in the log.
  console.log(`::add-mask::${idToken}`);
  return idToken;
};

/**
 * This function reads one element out of an AWS STS XML response.
 *
 * STS speaks the query protocol, which answers in XML rather than JSON. The
 * values wanted here never contain a "<", so finding the element is enough and
 * a parser isn't.
 */
const element = (body: string, tag: string): string | undefined =>
  body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

/**
 * This function masks a secret in the workflow log.
 *
 * This is the ::add-mask:: workflow command, which @actions/core's setSecret
 * writes too. The credentials aren't printed anywhere here, but they are
 * secrets that this process now holds, so anything that does print them should
 * print asterisks.
 */
const mask = (secret: string): void => {
  console.log(`::add-mask::${secret}`);
};

const endpointOf = (inputs: Inputs): string =>
  inputs.endpoint ??
    (inputs.region
      ? `https://sts.${inputs.region}.amazonaws.com/`
      : "https://sts.amazonaws.com/");

/**
 * This function returns a function which assumes an IAM role with the GitHub
 * OIDC token.
 *
 * The OIDC token is read only when the credentials are actually needed, and
 * again on every call, so a token is never reused past its own lifetime.
 *
 * AssumeRoleWithWebIdentity takes no AWS credentials and carries no signature,
 * because the OIDC token is what authenticates the caller. So this is a plain
 * HTTPS request.
 */
export const credentials = (inputs: Inputs): Credentials => {
  const audience = inputs.audience ?? defaultAudience;
  const read = inputs.getIdToken ?? getIdToken;
  const endpoint = endpointOf(inputs);

  return async () => {
    const webIdentityToken = await read(audience);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Action: "AssumeRoleWithWebIdentity",
        Version: "2011-06-15",
        RoleArn: inputs.roleArn,
        RoleSessionName: inputs.roleSessionName ?? defaultRoleSessionName,
        DurationSeconds: String(
          inputs.durationSeconds ?? defaultDurationSeconds,
        ),
        WebIdentityToken: webIdentityToken,
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      // An STS error names what went wrong, which is worth surfacing: a trust
      // policy that doesn't allow the sub claim is the usual cause.
      const code = element(body, "Code");
      const message = element(body, "Message");
      throw new Error(
        `failed to assume ${inputs.roleArn}: ${response.status}${
          code ? ` ${code}` : ""
        }${message ? `: ${message}` : ""}`,
      );
    }

    const accessKeyId = element(body, "AccessKeyId");
    const secretAccessKey = element(body, "SecretAccessKey");
    const sessionToken = element(body, "SessionToken");
    const expiration = element(body, "Expiration");
    if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
      throw new Error("AWS STS returned no credentials");
    }
    mask(secretAccessKey);
    mask(sessionToken);
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      expiration: new Date(expiration),
    };
  };
};
