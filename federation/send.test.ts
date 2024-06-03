import { configure, getConsoleSink, reset } from "@logtape/logtape";
import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import * as mf from "mock_fetch";
import { verifyRequest } from "../sig/http.ts";
import { doesActorOwnKey } from "../sig/owner.ts";
import { mockDocumentLoader } from "../testing/docloader.ts";
import { rsaPrivateKey2, rsaPublicKey2 } from "../testing/keys.ts";
import type { Actor } from "../vocab/actor.ts";
import {
  Activity,
  Application,
  Create,
  Endpoints,
  Group,
  Person,
  Service,
} from "../vocab/vocab.ts";
import { extractInboxes, sendActivity } from "./send.ts";

Deno.test("extractInboxes()", () => {
  const recipients: Actor[] = [
    new Person({
      id: new URL("https://example.com/alice"),
      inbox: new URL("https://example.com/alice/inbox"),
      endpoints: new Endpoints({
        sharedInbox: new URL("https://example.com/inbox"),
      }),
    }),
    new Application({
      id: new URL("https://example.com/app"),
      inbox: new URL("https://example.com/app/inbox"),
      endpoints: new Endpoints({
        sharedInbox: new URL("https://example.com/inbox"),
      }),
    }),
    new Group({
      id: new URL("https://example.org/group"),
      inbox: new URL("https://example.org/group/inbox"),
    }),
    new Service({
      id: new URL("https://example.net/service"),
      inbox: new URL("https://example.net/service/inbox"),
      endpoints: new Endpoints({
        sharedInbox: new URL("https://example.net/inbox"),
      }),
    }),
  ];
  let inboxes = extractInboxes({ recipients });
  assertEquals(
    inboxes,
    {
      "https://example.com/alice/inbox": new Set(["https://example.com/alice"]),
      "https://example.com/app/inbox": new Set(["https://example.com/app"]),
      "https://example.org/group/inbox": new Set(["https://example.org/group"]),
      "https://example.net/service/inbox": new Set([
        "https://example.net/service",
      ]),
    },
  );
  inboxes = extractInboxes({ recipients, preferSharedInbox: true });
  assertEquals(
    inboxes,
    {
      "https://example.com/inbox": new Set([
        "https://example.com/alice",
        "https://example.com/app",
      ]),
      "https://example.org/group/inbox": new Set(["https://example.org/group"]),
      "https://example.net/inbox": new Set(["https://example.net/service"]),
    },
  );
  inboxes = extractInboxes({
    recipients,
    excludeBaseUris: [new URL("https://foo.bar/")],
  });
  assertEquals(
    inboxes,
    {
      "https://example.com/alice/inbox": new Set(["https://example.com/alice"]),
      "https://example.com/app/inbox": new Set(["https://example.com/app"]),
      "https://example.org/group/inbox": new Set(["https://example.org/group"]),
      "https://example.net/service/inbox": new Set([
        "https://example.net/service",
      ]),
    },
  );
  inboxes = extractInboxes({
    recipients,
    excludeBaseUris: [new URL("https://example.com/")],
  });
  assertEquals(
    inboxes,
    {
      "https://example.org/group/inbox": new Set(["https://example.org/group"]),
      "https://example.net/service/inbox": new Set([
        "https://example.net/service",
      ]),
    },
  );
  inboxes = extractInboxes({
    recipients,
    preferSharedInbox: true,
    excludeBaseUris: [new URL("https://example.com/")],
  });
  assertEquals(
    inboxes,
    {
      "https://example.org/group/inbox": new Set(["https://example.org/group"]),
      "https://example.net/inbox": new Set(["https://example.net/service"]),
    },
  );
});

Deno.test("sendActivity()", async (t) => {
  mf.install();

  await configure({
    sinks: {
      console: getConsoleSink(),
    },
    filters: {},
    loggers: [
      {
        category: ["fedify", "federation", "outbox"],
        level: "debug",
        sinks: ["console"],
      },
      {
        category: ["logtape", "meta"],
        level: "warning",
        sinks: ["console"],
      },
    ],
  });

  let verified: boolean | null = null;
  let request: Request | null = null;
  mf.mock("POST@/inbox", async (req) => {
    request = req;
    const options = {
      documentLoader: mockDocumentLoader,
      contextLoader: mockDocumentLoader,
    };
    const key = await verifyRequest(req, options);
    const activity = await Activity.fromJsonLd(await req.json(), options);
    if (key != null && await doesActorOwnKey(activity, key, options)) {
      verified = true;
      return new Response("", { status: 202 });
    }
    verified = false;
    return new Response("", { status: 401 });
  });

  await t.step("success", async () => {
    const activity = new Create({
      actor: new URL("https://example.com/person"),
    });
    await sendActivity({
      activity,
      privateKey: rsaPrivateKey2,
      keyId: rsaPublicKey2.id!,
      inbox: new URL("https://example.com/inbox"),
      contextLoader: mockDocumentLoader,
      headers: new Headers({
        "X-Test": "test",
      }),
    });
    assertStrictEquals(verified, true);
    assertNotEquals(request, null);
    assertEquals(request?.method, "POST");
    assertEquals(request?.url, "https://example.com/inbox");
    assertEquals(
      request?.headers.get("Content-Type"),
      "application/activity+json",
    );
    assertEquals(request?.headers.get("X-Test"), "test");
  });

  mf.mock("POST@/inbox2", (_req) => {
    return new Response("something went wrong", {
      status: 500,
      statusText: "Internal Server Error",
    });
  });

  await t.step("failure", async () => {
    let activity = new Create({
      id: new URL("https://example.com/activity"),
      actor: new URL("https://example.com/person"),
    });
    await assertRejects(
      () =>
        sendActivity({
          activity,
          privateKey: rsaPrivateKey2,
          keyId: rsaPublicKey2.id!,
          inbox: new URL("https://example.com/inbox2"),
          contextLoader: mockDocumentLoader,
        }),
      Error,
      "Failed to send activity https://example.com/activity to " +
        "https://example.com/inbox2 (500 Internal Server Error):\n" +
        "something went wrong",
    );

    activity = new Create({});
    await assertRejects(
      () =>
        sendActivity({
          activity,
          privateKey: rsaPrivateKey2,
          keyId: rsaPublicKey2.id!,
          inbox: new URL("https://example.com/inbox2"),
          contextLoader: mockDocumentLoader,
        }),
      TypeError,
      "The activity to send must have at least one actor property.",
    );
  });

  await reset();
  mf.uninstall();
});
