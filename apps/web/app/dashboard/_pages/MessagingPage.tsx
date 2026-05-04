"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiError, type ConversationMessage, type MessagingConversation, type OrganizationMember } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { StatusPill } from "../../../components/ui/StatusPill";

type LoadState = "loading" | "ready" | "error";

function prettyTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function MessagingPage() {
  const { messaging, organization, currentUser } = useNumeriquApi();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [conversations, setConversations] = useState<MessagingConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [peerId, setPeerId] = useState("");
  const [sending, setSending] = useState(false);
  const [creatingDm, setCreatingDm] = useState(false);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

  async function loadConversations() {
    setState("loading");
    try {
      const [nextMembers, nextConversations] = await Promise.all([
        organization.members(),
        messaging.conversations(),
      ]);
      setMembers(nextMembers);
      setConversations(nextConversations);
      setSelectedConversationId((current) => current ?? nextConversations[0]?.id ?? null);
      setError(null);
      setState("ready");
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't load conversations.")
          : "We couldn't load conversations.";
      setError(message);
      setState("error");
    }
  }

  useEffect(() => {
    void loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      return;
    }
    messaging
      .messages(selectedConversationId)
      .then((payload) => {
        setMessages(payload);
      })
      .catch((caught) => {
        const message =
          caught instanceof ApiError
            ? caught.toUserMessage("We couldn't load messages in this conversation.")
            : "We couldn't load messages in this conversation.";
        setError(message);
      });
  }, [messaging, selectedConversationId]);

  async function createDirectMessage() {
    if (!peerId) {
      setError("Select a teammate to start a direct conversation.");
      return;
    }
    setCreatingDm(true);
    setError(null);
    try {
      const created = await messaging.createDm(peerId);
      await loadConversations();
      setSelectedConversationId(created.id);
      setPeerId("");
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't start this conversation.")
          : "We couldn't start this conversation.";
      setError(message);
    } finally {
      setCreatingDm(false);
    }
  }

  async function sendMessage() {
    if (!selectedConversationId || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await messaging.sendMessage({
        conversationId: selectedConversationId,
        content: draft.trim(),
      });
      setDraft("");
      const nextMessages = await messaging.messages(selectedConversationId);
      setMessages(nextMessages);
      const nextConversations = await messaging.conversations();
      setConversations(nextConversations);
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("Message could not be sent. Please try again.")
          : "Message could not be sent. Please try again.";
      setError(message);
    } finally {
      setSending(false);
    }
  }

  const availablePeers = members.filter((member) => member.user.id !== currentUser?.user.id);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">
          Messaging
        </p>
        <h2 className="font-display text-2xl font-bold text-text-primary md:text-3xl">
          Keep financial decisions aligned in context
        </h2>
        <p className="text-sm text-text-muted">
          Organization-bound conversations for finance, operations, and planning.
        </p>
      </header>

      {error ? (
        <ErrorBanner title="Messaging issue" tone="danger" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}

      <section className="surface-card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="flex-1">
            <label className="block text-sm font-medium text-text-secondary">Start a direct chat</label>
            <select
              value={peerId}
              onChange={(event) => setPeerId(event.target.value)}
              className="mt-1 w-full rounded-xl border border-default bg-surface-card/70 px-4 py-2.5 text-text-primary outline-none focus:border-accent-blue/60"
            >
              <option value="">Select teammate</option>
              {availablePeers.map((member) => (
                <option key={member.user.id} value={member.user.id}>
                  {member.user.fullName || member.user.email}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={() => void createDirectMessage()} loading={creatingDm}>
            {creatingDm ? "Creating..." : "Start DM"}
          </Button>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <div className="surface-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-text-primary">Conversations</p>
            <StatusPill tone="neutral" withDot={false}>
              {conversations.length}
            </StatusPill>
          </div>
          <div className="space-y-2">
            {state === "loading" ? (
              Array.from({ length: 5 }).map((_, idx) => <Skeleton key={idx} height={76} rounded="xl" />)
            ) : conversations.length === 0 ? (
              <EmptyState
                title="No conversations yet"
                detail="Start a direct chat with a teammate to begin."
              />
            ) : (
              conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => setSelectedConversationId(conversation.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    selectedConversationId === conversation.id
                      ? "border-accent-blue/50 bg-accent-blue/10"
                      : "border-default bg-bg-elevated/40 hover:border-strong"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {conversation.type === "DM" ? "Direct message" : "Group chat"}
                    </p>
                    <StatusPill tone="neutral">{conversation.type.toLowerCase()}</StatusPill>
                  </div>
                  <p className="mt-1 truncate text-xs text-text-muted">
                    {conversation.participants.map((part) => part.fullName || part.email).join(", ")}
                  </p>
                  {conversation.latestMessage ? (
                    <p className="mt-2 truncate text-xs text-text-secondary">
                      {conversation.latestMessage.content ?? "Message deleted"}
                    </p>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="surface-card flex min-h-[500px] flex-col p-4">
          <div className="border-b border-default pb-3">
            <p className="text-sm font-semibold text-text-primary">
              {selectedConversation
                ? selectedConversation.type === "DM"
                  ? "Direct conversation"
                  : "Group conversation"
                : "Select a conversation"}
            </p>
            {selectedConversation ? (
              <p className="text-xs text-text-muted">
                {selectedConversation.participants.length} participant
                {selectedConversation.participants.length === 1 ? "" : "s"}
              </p>
            ) : null}
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto py-4">
            {!selectedConversation ? (
              <EmptyState
                title="No conversation selected"
                detail="Pick a conversation from the left panel."
              />
            ) : messages.length === 0 ? (
              <EmptyState title="No messages yet" detail="Start with a clear objective for your team." />
            ) : (
              messages.map((message) => {
                const mine = message.senderId === currentUser?.user.id;
                const sender = members.find((member) => member.user.id === message.senderId);
                return (
                  <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm ${
                        mine
                          ? "bg-accent-blue/15 text-text-primary ring-1 ring-accent-blue/30"
                          : "bg-bg-elevated/50 text-text-primary ring-1 ring-default"
                      }`}
                    >
                      <p className="text-[11px] text-text-muted">
                        {(sender?.user.fullName || sender?.user.email || "Member")} · {prettyTime(message.createdAt)}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap leading-relaxed">
                        {message.content ?? "Message deleted"}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <form
            className="mt-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={selectedConversation ? "Write a message..." : "Select a conversation first"}
              disabled={!selectedConversation || sending}
              className="w-full rounded-full border border-default bg-surface-card/60 px-4 py-2 text-sm text-text-primary outline-none focus:border-accent-blue/60 disabled:opacity-50"
            />
            <Button type="submit" loading={sending} disabled={!selectedConversation || !draft.trim() || sending}>
              Send
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}
