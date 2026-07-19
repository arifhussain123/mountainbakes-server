import type { UserRole } from './user.types';

export type ChatType = 'dm' | 'group';
export type MessageType = 'text' | 'image' | 'file' | 'system';
export type PresenceStatus = 'online' | 'offline' | 'away';
export type GroupChatType = 'admin_only' | 'production_team' | 'all_branch_managers' | 'custom';

export interface ChatMember {
  uid: string;
  displayName: string;
  role: UserRole;
  branchName: string | null;
}

export interface ChatAttachment {
  url: string;
  storagePath: string;
  name: string;
  size: number;
  mimeType: string;
  thumbnailUrl: string | null;
}

export interface MessageReply {
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  type: MessageType;
}

export interface LastMessage {
  text: string;
  senderId: string;
  senderName: string;
  sentAt: string;
  type: MessageType;
}

export interface Chat {
  id: string;
  type: ChatType;
  name: string | null;
  description: string | null;
  avatarUrl: string | null;
  members: string[];
  memberDetails: Record<string, ChatMember>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: LastMessage | null;
  unreadCounts: Record<string, number>;
  typing: Record<string, string>;
  isPinned: Record<string, boolean>;
  isArchived: Record<string, boolean>;
  groupType: GroupChatType | null;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderRole: UserRole;
  text: string | null;
  type: MessageType;
  attachments: ChatAttachment[];
  replyTo: MessageReply | null;
  readBy: Record<string, string>;
  editedAt: string | null;
  deletedAt: string | null;
  isPinned: boolean;
  pinnedBy: string | null;
  pinnedAt: string | null;
  sentAt: string;
}

export interface UserPresence {
  uid: string;
  displayName: string;
  status: PresenceStatus;
  lastSeen: string;
  updatedAt: string;
}

export interface CreateDMChatInput {
  targetUid: string;
  targetMember: ChatMember;
}

export interface CreateGroupChatInput {
  name: string;
  description?: string;
  memberUids: string[];
  memberDetails: Record<string, ChatMember>;
  groupType: GroupChatType;
}

export interface SendMessageInput {
  text: string | null;
  type: MessageType;
  attachments?: ChatAttachment[];
  replyTo?: MessageReply | null;
}
