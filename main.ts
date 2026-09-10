/**
 * This module gets AWS credentials on GitHub Actions by assuming an IAM role
 * with the GitHub OIDC token.
 *
 * Unlike aws-actions/configure-aws-credentials, the credentials are not
 * exported as environment variables and are not written to ~/.aws/credentials,
 * so they stay inside the action asking for them and later steps of the job
 * can't see them.
 *
 * @example
 * ```ts
 * import { KMSClient } from "@aws-sdk/client-kms";
 * import { credentials } from "@suzuki-shunsuke/actions-aws-oidc";
 *
 * const client = new KMSClient({
 *   credentials: credentials({
 *     roleArn: "arn:aws:iam::123456789012:role/example",
 *   }),
 * });
 * ```
 *
 * The job needs the permission `id-token: write`.
 *
 * @module
 */

import process from "node:process";
import { fromWebToken } from "@aws-sdk/credential-provider-web-identity";

/** An AWS credential provider, which every AWS SDK client accepts. */
export type Credentials = ReturnType<typeof fromWebToken>;

/** A function returning a GitHub OIDC token for the given audience. */
export type GetIdToken = (audience: string) => Promise<string>;

/** The audience AWS STS expects from the GitHub OIDC provider. */
const defaultAudience = "sts.amazonaws.com";

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
  /** It defaults to "GitHubActions". */
  roleSessionName?: string;
  /** It defaults to "sts.amazonaws.com", which is what AWS STS expects. */
  audience?: string;
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
 * This function returns an AWS credential provider which assumes an IAM role
 * with the GitHub OIDC token.
 *
 * The OIDC token is read only when the credentials are actually needed, and
 * again whenever the AWS SDK finds them expired, so a token is never reused
 * past its own lifetime.
 */
export const credentials = (inputs: Inputs): Credentials => {
  const audience = inputs.audience ?? defaultAudience;
  const read = inputs.getIdToken ?? getIdToken;
  return (options) =>
    read(audience).then((webIdentityToken) =>
      fromWebToken({
        roleArn: inputs.roleArn,
        webIdentityToken: webIdentityToken,
        roleSessionName: inputs.roleSessionName,
        durationSeconds: inputs.durationSeconds ?? defaultDurationSeconds,
      })(options)
    );
};
