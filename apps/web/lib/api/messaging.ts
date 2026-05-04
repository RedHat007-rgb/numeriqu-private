import { createRequester, type TokenProvider } from "./base";
import type { ConversationMessage, MessagingConversation } from "./types";

export class MessagingApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  conversations() {
    return this.request<MessagingConversation[]>("/messaging/conversations");
  }

  createDm(peerUserId: string) {
    return this.request<{ id: string; type: "DM" }>(
      "/messaging/conversations/dm",
      { method: "POST", body: JSON.stringify({ peerUserId }) },
    );
  }

  createGroup(participantUserIds: string[]) {
    return this.request<{ id: string; type: "GROUP" }>(
      "/messaging/conversations/group",
      { method: "POST", body: JSON.stringify({ participantUserIds }) },
    );
  }

  messages(conversationId: string) {
    return this.request<ConversationMessage[]>(`/messaging/conversations/${conversationId}/messages`);
  }

  sendMessage(params: { conversationId: string; content: string; dashboardId?: string }) {
    return this.request<{ id: string; content: string; senderId: string; createdAt: string }>(
      `/messaging/conversations/${params.conversationId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content: params.content,
          dashboardId: params.dashboardId,
        }),
      },
    );
  }

  editMessage(messageId: string, content: string) {
    return this.request<{ success: true }>(`/messaging/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    });
  }

  deleteMessage(messageId: string) {
    return this.request<{ success: true }>(`/messaging/messages/${messageId}`, {
      method: "DELETE",
    });
  }
}
