import { DocumentLoader, fetchDocumentLoader } from "../runtime/docloader.ts";
import { Actor } from "../vocab/actor.ts";
import { Activity } from "../vocab/mod.ts";
import { handleWebFinger } from "../webfinger/handler.ts";
import {
  ActorDispatcher,
  InboxListener,
  OutboxCounter,
  OutboxCursor,
  OutboxDispatcher,
} from "./callback.ts";
import { Context } from "./context.ts";
import { handleActor, handleInbox, handleOutbox } from "./handler.ts";
import { Router, RouterError } from "./router.ts";

/**
 * Parameters for initializing a {@link Federation} instance.
 */
export interface FederationParameters {
  documentLoader?: DocumentLoader;
  treatHttps?: boolean;
}

/**
 * An object that registers federation-related business logic and dispatches
 * requests to the appropriate handlers.
 *
 * It also provides a middleware interface for handling requests before your
 * web framework's router; see {@link Federation.handle}.
 */
export class Federation<TContextData> {
  #router: Router;
  #actorDispatcher?: ActorDispatcher<TContextData>;
  #outboxCallbacks?: {
    dispatcher: OutboxDispatcher<TContextData>;
    counter?: OutboxCounter<TContextData>;
    firstCursor?: OutboxCursor<TContextData>;
    lastCursor?: OutboxCursor<TContextData>;
  };
  #inboxListeners: Map<
    new (...args: unknown[]) => Activity,
    InboxListener<TContextData, Activity>
  >;
  #inboxErrorHandler?: (error: Error) => void | Promise<void>;
  #documentLoader: DocumentLoader;
  #treatHttps: boolean;

  /**
   * Create a new {@link Federation} instance.
   */
  constructor({ documentLoader, treatHttps }: FederationParameters = {}) {
    this.#router = new Router();
    this.#router.add("/.well-known/webfinger", "webfinger");
    this.#inboxListeners = new Map();
    this.#documentLoader = documentLoader ?? fetchDocumentLoader;
    this.#treatHttps = treatHttps ?? false;
  }

  /**
   * Registers an actor dispatcher.
   * @param path The URI path pattern for the actor dispatcher.  The syntax is
   *             based on URI Template
   *             ([RFC 6570](https://tools.ietf.org/html/rfc6570)).  The path
   *             must have one variable: `{handle}`.
   * @param dispatcher An actor dispatcher callback to register.
   * @throws {@link RouterError} Thrown if the path pattern is invalid.
   */
  setActorDispatcher(
    path: string,
    dispatcher: ActorDispatcher<TContextData>,
  ): void {
    if (this.#router.has("actor")) {
      throw new RouterError("Actor dispatcher already set.");
    }
    const variables = this.#router.add(path, "actor");
    if (variables.size !== 1 || !variables.has("handle")) {
      throw new RouterError(
        "Path for actor dispatcher must have one variable: {handle}",
      );
    }
    this.#actorDispatcher = dispatcher;
  }

  /**
   * Registers an outbox dispatcher.
   * @param path The URI path pattern for the outbox dispatcher.  The syntax is
   *             based on URI Template
   *             ([RFC 6570](https://tools.ietf.org/html/rfc6570)).  The path
   *             must have one variable: `{handle}`.
   * @param dispatcher An outbox dispatcher callback to register.
   * @throws {@link RouterError} Thrown if the path pattern is invalid.
   */
  setOutboxDispatcher(
    path: string,
    dispatcher: OutboxDispatcher<TContextData>,
  ): OutboxCallbackSetters<TContextData> {
    if (this.#router.has("outbox")) {
      throw new RouterError("Outbox dispatcher already set.");
    }
    const variables = this.#router.add(path, "outbox");
    if (variables.size !== 1 || !variables.has("handle")) {
      throw new RouterError(
        "Path for outbox dispatcher must have one variable: {handle}",
      );
    }
    const callbacks: {
      dispatcher: OutboxDispatcher<TContextData>;
      counter?: OutboxCounter<TContextData>;
      firstCursor?: OutboxCursor<TContextData>;
      lastCursor?: OutboxCursor<TContextData>;
    } = { dispatcher };
    this.#outboxCallbacks = callbacks;
    const setters: OutboxCallbackSetters<TContextData> = {
      setCounter(counter: OutboxCounter<TContextData>) {
        callbacks.counter = counter;
        return setters;
      },
      setFirstCursor(cursor: OutboxCursor<TContextData>) {
        callbacks.firstCursor = cursor;
        return setters;
      },
      setLastCursor(cursor: OutboxCursor<TContextData>) {
        callbacks.lastCursor = cursor;
        return setters;
      },
    };
    return setters;
  }

  setInboxListeners(path: string): InboxListenerSetter<TContextData> {
    if (this.#router.has("inbox")) {
      throw new RouterError("Inbox already set.");
    }
    const variables = this.#router.add(path, "inbox");
    if (variables.size !== 1 || !variables.has("handle")) {
      throw new RouterError(
        "Path for inbox must have one variable: {handle}",
      );
    }
    const listeners = this.#inboxListeners;
    const setter: InboxListenerSetter<TContextData> = {
      on<TActivity extends Activity>(
        // deno-lint-ignore no-explicit-any
        type: new (...args: any[]) => TActivity,
        listener: InboxListener<TContextData, TActivity>,
      ): InboxListenerSetter<TContextData> {
        if (listeners.has(type)) {
          throw new TypeError("Listener already set for this type.");
        }
        listeners.set(type, listener as InboxListener<TContextData, Activity>);
        return setter;
      },
      onError: (
        handler: (error: Error) => void | Promise<void>,
      ): InboxListenerSetter<TContextData> => {
        this.#inboxErrorHandler = handler;
        return setter;
      },
    };
    return setter;
  }

  /**
   * Handles a request related to federation.
   * @param request The request object.
   * @param parameters The parameters for handling the request.
   * @returns The response to the request.
   */
  async handle(
    request: Request,
    {
      onNotFound,
      onNotAcceptable,
      contextData,
    }: FederationHandlerParameters<TContextData>,
  ): Promise<Response> {
    const url = new URL(request.url);
    const route = this.#router.route(url.pathname);
    if (route == null) {
      const response = onNotFound(request);
      return response instanceof Promise ? await response : response;
    }
    const context = new Context(
      this.#router,
      this.#documentLoader,
      request,
      contextData,
      this.#treatHttps,
    );
    switch (route.name) {
      case "webfinger":
        return await handleWebFinger(request, {
          context,
          actorDispatcher: this.#actorDispatcher,
          onNotFound,
        });
      case "actor":
        return await handleActor(request, {
          handle: route.values.handle,
          context,
          documentLoader: this.#documentLoader,
          actorDispatcher: this.#actorDispatcher,
          onNotFound,
          onNotAcceptable,
        });
      case "outbox":
        return await handleOutbox(request, {
          handle: route.values.handle,
          context,
          documentLoader: this.#documentLoader,
          outboxDispatcher: this.#outboxCallbacks?.dispatcher,
          outboxCounter: this.#outboxCallbacks?.counter,
          outboxFirstCursor: this.#outboxCallbacks?.firstCursor,
          outboxLastCursor: this.#outboxCallbacks?.lastCursor,
          onNotFound,
          onNotAcceptable,
        });
      case "inbox":
        return await handleInbox(request, {
          handle: route.values.handle,
          context,
          documentLoader: this.#documentLoader,
          actorDispatcher: this.#actorDispatcher,
          inboxListeners: this.#inboxListeners,
          inboxErrorHandler: this.#inboxErrorHandler,
          onNotFound,
        });
      default: {
        const response = onNotFound(request);
        return response instanceof Promise ? await response : response;
      }
    }
  }
}

export interface FederationHandlerParameters<TContextData> {
  contextData: TContextData;
  onNotFound(request: Request): Response | Promise<Response>;
  onNotAcceptable(request: Request): Response | Promise<Response>;
}

export interface OutboxCallbackSetters<TContextData> {
  setCounter(
    counter: OutboxCounter<TContextData>,
  ): OutboxCallbackSetters<TContextData>;

  setFirstCursor(
    cursor: OutboxCursor<TContextData>,
  ): OutboxCallbackSetters<TContextData>;

  setLastCursor(
    cursor: OutboxCursor<TContextData>,
  ): OutboxCallbackSetters<TContextData>;
}

export interface InboxListenerSetter<TContextData> {
  on<TActivity extends Activity>(
    // deno-lint-ignore no-explicit-any
    type: new (...args: any[]) => TActivity,
    listener: InboxListener<TContextData, TActivity>,
  ): InboxListenerSetter<TContextData>;
  onError(
    handler: (error: Error) => void | Promise<void>,
  ): InboxListenerSetter<TContextData>;
}
