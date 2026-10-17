// Replies being written right now, per conversation. A reply runs to the end even when the browser
// goes away (a phone's screen locking closes the connection), so stopping one is its own request,
// and a page that comes back asks here whether its reply is still on the way. In memory: with one
// api process that's all of them. More than one would need this shared (Redis, or a table).

type Active = { userId: number; controller: AbortController };

export class ActiveReplies {
  #replies = new Map<number, Active>();

  /** Registers a reply; the returned function ends it (call it once the reply is saved or has failed). */
  start(conversationId: number, userId: number, controller: AbortController): () => void {
    const entry = { userId, controller };
    this.#replies.set(conversationId, entry);
    return () => {
      if (this.#replies.get(conversationId) === entry) this.#replies.delete(conversationId);
    };
  }

  running(conversationId: number, userId: number): boolean {
    return this.#replies.get(conversationId)?.userId === userId;
  }

  /** Stops the user's reply in that conversation. False if there was none. */
  stop(conversationId: number, userId: number): boolean {
    const entry = this.#replies.get(conversationId);
    if (entry?.userId !== userId) return false;
    entry.controller.abort();
    return true;
  }
}
