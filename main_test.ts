import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import process from "node:process";
import { credentials, type GetIdToken, getIdToken } from "./main.ts";

/**
 * This function replaces globalThis.fetch with a fake one and records requests.
 *
 * A response is built per call rather than shared, because a body can only be
 * read once and a test may make more than one request.
 */
const withFakeFetch = async (
  response: Response | (() => Response),
  fn: (requests: Request[]) => Promise<void>,
): Promise<void> => {
  const requests: Request[] = [];
  const original = globalThis.fetch;
  const build = typeof response === "function"
    ? response
    : () => response.clone();
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(String(url), init));
    return Promise.resolve(build());
  }) as typeof fetch;
  try {
    await fn(requests);
  } finally {
    globalThis.fetch = original;
  }
};

/** This function sets the GitHub Actions OIDC environment variables. */
const withOidcEnv = async (
  env: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> => {
  const keys = [
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ];
  const original = keys.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of keys) {
      const value = env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fn();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const oidcEnv = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.com/token?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

Deno.test("getIdToken requests a token for the given audience", async () => {
  await withOidcEnv(oidcEnv, async () => {
    await withFakeFetch(
      Response.json({ value: "id-token" }),
      async (requests) => {
        assertEquals(await getIdToken("sts.amazonaws.com"), "id-token");

        assertEquals(requests.length, 1);
        assertEquals(
          requests[0].url,
          "https://example.com/token?api-version=2.0&audience=sts.amazonaws.com",
        );
        assertEquals(
          requests[0].headers.get("authorization"),
          "Bearer request-token",
        );
      },
    );
  });
});

Deno.test("getIdToken masks the token in the workflow log", async () => {
  await withOidcEnv(oidcEnv, async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      await withFakeFetch(Response.json({ value: "id-token" }), async () => {
        await getIdToken("sts.amazonaws.com");
      });
    } finally {
      console.log = original;
    }
    assertEquals(lines, ["::add-mask::id-token"]);
  });
});

Deno.test("getIdToken explains a missing permission", async () => {
  await withOidcEnv({}, async () => {
    const error = await assertRejects(() => getIdToken("sts.amazonaws.com"));
    assertStringIncludes(
      (error as Error).message,
      "ACTIONS_ID_TOKEN_REQUEST_URL",
    );
    assertStringIncludes((error as Error).message, "id-token: write");
  });
});

Deno.test("getIdToken fails if GitHub rejects the request", async () => {
  await withOidcEnv(oidcEnv, async () => {
    await withFakeFetch(
      new Response(null, { status: 403, statusText: "Forbidden" }),
      async () => {
        await assertRejects(
          () => getIdToken("sts.amazonaws.com"),
          Error,
          "failed to get a GitHub OIDC token: 403",
        );
      },
    );
  });
});

Deno.test("getIdToken fails if the response carries no token", async () => {
  await withOidcEnv(oidcEnv, async () => {
    await withFakeFetch(Response.json({}), async () => {
      await assertRejects(
        () => getIdToken("sts.amazonaws.com"),
        Error,
        "GitHub returned no OIDC token",
      );
    });
  });
});

const roleArn = "arn:aws:iam::123456789012:role/example";

const stubIdToken = (audiences: string[]): GetIdToken => (audience) => {
  audiences.push(audience);
  return Promise.resolve("id-token");
};

const expiration = "2026-09-11T12:00:00Z";

// These stand in for credentials without looking like any. AWS's own example
// values trip secret scanners once the ASIA prefix of a temporary key is put in
// front of them, and nothing here depends on the shape. The "/" is kept because
// a real secret access key contains one, and it has to survive being read out
// of the XML.

const stsResponse = () =>
  new Response(
    `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>test-access-key-id</AccessKeyId>
      <SecretAccessKey>test/secret-access-key</SecretAccessKey>
      <SessionToken>session-token</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`,
    { status: 200 },
  );

/** This runs fn with console.log captured, so ::add-mask:: doesn't reach the output. */
const withQuietLog = async (fn: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
};

Deno.test("credentials assumes the role with the OIDC token", async () => {
  const audiences: string[] = [];
  await withFakeFetch(stsResponse(), async (requests) => {
    await withQuietLog(async () => {
      const got = await credentials({
        roleArn,
        getIdToken: stubIdToken(audiences),
      })();

      assertEquals(got, {
        accessKeyId: "test-access-key-id",
        secretAccessKey: "test/secret-access-key",
        sessionToken: "session-token",
        expiration: new Date(expiration),
      });
    });

    assertEquals(audiences, ["sts.amazonaws.com"]);
    assertEquals(requests.length, 1);
    assertEquals(requests[0].url, "https://sts.amazonaws.com/");
    assertEquals(requests[0].method, "POST");

    const body = new URLSearchParams(await requests[0].text());
    assertEquals(body.get("Action"), "AssumeRoleWithWebIdentity");
    assertEquals(body.get("Version"), "2011-06-15");
    assertEquals(body.get("RoleArn"), roleArn);
    assertEquals(body.get("WebIdentityToken"), "id-token");
    // Defaults: the session name configure-aws-credentials uses, and the
    // shortest session AWS STS accepts.
    assertEquals(body.get("RoleSessionName"), "GitHubActions");
    assertEquals(body.get("DurationSeconds"), "900");

    // The call carries no signature, because the OIDC token authenticates it.
    assertEquals(requests[0].headers.get("authorization"), null);
  });
});

Deno.test("credentials masks the secrets in the workflow log", async () => {
  await withFakeFetch(stsResponse(), async () => {
    const lines = await withQuietLog(async () => {
      await credentials({ roleArn, getIdToken: stubIdToken([]) })();
    });
    assertEquals(lines, [
      "::add-mask::test/secret-access-key",
      "::add-mask::session-token",
    ]);
  });
});

Deno.test("credentials honours the session name and the duration", async () => {
  await withFakeFetch(stsResponse(), async (requests) => {
    await withQuietLog(async () => {
      await credentials({
        roleArn,
        roleSessionName: "example",
        durationSeconds: 3600,
        getIdToken: stubIdToken([]),
      })();
    });
    const body = new URLSearchParams(await requests[0].text());
    assertEquals(body.get("RoleSessionName"), "example");
    assertEquals(body.get("DurationSeconds"), "3600");
  });
});

Deno.test("credentials honours a custom audience", async () => {
  const audiences: string[] = [];
  await withFakeFetch(stsResponse(), async () => {
    await withQuietLog(async () => {
      await credentials({
        roleArn,
        audience: "example.com",
        getIdToken: stubIdToken(audiences),
      })();
    });
  });
  assertEquals(audiences, ["example.com"]);
});

Deno.test("credentials calls the regional STS endpoint when asked", async () => {
  await withFakeFetch(stsResponse(), async (requests) => {
    await withQuietLog(async () => {
      await credentials({
        roleArn,
        region: "ap-northeast-1",
        getIdToken: stubIdToken([]),
      })();
    });
    assertEquals(requests[0].url, "https://sts.ap-northeast-1.amazonaws.com/");
  });
});

Deno.test("credentials lets an endpoint override the region", async () => {
  await withFakeFetch(stsResponse(), async (requests) => {
    await withQuietLog(async () => {
      await credentials({
        roleArn,
        region: "ap-northeast-1",
        endpoint: "https://sts.cn-north-1.amazonaws.com.cn/",
        getIdToken: stubIdToken([]),
      })();
    });
    assertEquals(requests[0].url, "https://sts.cn-north-1.amazonaws.com.cn/");
  });
});

Deno.test("credentials reports what AWS STS rejected", async () => {
  const body =
    `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <Error>
    <Code>AccessDenied</Code>
    <Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message>
  </Error>
</ErrorResponse>`;
  await withFakeFetch(new Response(body, { status: 403 }), async () => {
    const error = await assertRejects(() =>
      credentials({ roleArn, getIdToken: stubIdToken([]) })()
    );
    assertStringIncludes((error as Error).message, roleArn);
    assertStringIncludes((error as Error).message, "403");
    assertStringIncludes((error as Error).message, "AccessDenied");
    assertStringIncludes(
      (error as Error).message,
      "Not authorized to perform sts:AssumeRoleWithWebIdentity",
    );
  });
});

Deno.test("credentials fails if the response carries no credentials", async () => {
  await withFakeFetch(new Response("<Empty/>", { status: 200 }), async () => {
    await assertRejects(
      () => credentials({ roleArn, getIdToken: stubIdToken([]) })(),
      Error,
      "AWS STS returned no credentials",
    );
  });
});

Deno.test("credentials doesn't read a token until it's invoked", () => {
  let called = false;
  credentials({
    roleArn,
    getIdToken: () => {
      called = true;
      return Promise.resolve("id-token");
    },
  });
  assertEquals(called, false);
});

Deno.test("credentials assumes the role again on every call", async () => {
  const audiences: string[] = [];
  await withFakeFetch(stsResponse, async (requests) => {
    await withQuietLog(async () => {
      const provider = credentials({
        roleArn,
        getIdToken: stubIdToken(audiences),
      });
      await provider();
      await provider();
    });
    // A session that has expired is never handed out, because none is held.
    assertEquals(audiences.length, 2);
    assertEquals(requests.length, 2);
  });
});
