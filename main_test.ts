import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import process from "node:process";
import { credentials, type GetIdToken, getIdToken } from "./main.ts";

/** This function replaces globalThis.fetch with a fake one and records requests. */
const withFakeFetch = async (
  response: Response,
  fn: (requests: Request[]) => Promise<void>,
): Promise<void> => {
  const requests: Request[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(String(url), init));
    return Promise.resolve(response);
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

Deno.test("credentials reads a token for the default audience", async () => {
  const audiences: string[] = [];
  const stub: GetIdToken = (audience) => {
    audiences.push(audience);
    return Promise.resolve("id-token");
  };

  // Whether the STS call that follows succeeds is beside the point and depends
  // on the environment, so its outcome is ignored. What matters is that the
  // provider read a token once it was invoked.
  await credentials({
    roleArn: "arn:aws:iam::123456789012:role/example",
    getIdToken: stub,
  })().catch(() => {});

  assertEquals(audiences, ["sts.amazonaws.com"]);
});

Deno.test("credentials honours a custom audience", async () => {
  const audiences: string[] = [];
  const stub: GetIdToken = (audience) => {
    audiences.push(audience);
    return Promise.resolve("id-token");
  };

  await credentials({
    roleArn: "arn:aws:iam::123456789012:role/example",
    audience: "example.com",
    getIdToken: stub,
  })().catch(() => {});

  assertEquals(audiences, ["example.com"]);
});

Deno.test("credentials doesn't read a token until it's invoked", () => {
  let called = false;
  credentials({
    roleArn: "arn:aws:iam::123456789012:role/example",
    getIdToken: () => {
      called = true;
      return Promise.resolve("id-token");
    },
  });
  assertEquals(called, false);
});
