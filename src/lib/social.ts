export interface ChatMessage {
  seq: number;
  id: string;
  sender: string;
  recipient: string;
  text: string;
  createdAt: number;
}

export interface SocialUser {
  username: string;
  online: boolean;
  version: number;
  unread: number;
  latest: number;
  lastMessage?: ChatMessage;
}

export interface ChatHistory {
  messages: ChatMessage[];
  latest: number;
  read: number;
}

export interface ChatBackup {
  threads: Record<string, ChatMessage[]>;
  reads: Record<string, string>;
}

export type SocialCommand = 'presence' | 'overview' | 'send' | 'history' | 'read' | 'export' | 'restore' | 'clear' | 'delete-user';

export const SOCIAL_KEYS = [
  'chat:threads', 'chat:reads', 'chat:presence:leases',
  'chat:presence:owners', 'chat:presence:users', 'chat:presence:version',
];

export const CHAT_ID = /^[a-zA-Z0-9_-]{16,80}$/;
export const CHAT_TEXT_LIMIT = 2000;
export const PRESENCE_LEASE_MS = 90000;
export const PRESENCE_GRACE_MS = 20000;

export function conversationId(first: string, second: string): string {
  return JSON.stringify([first, second].sort());
}

// 导入前完成校验，避免格式错误的聊天数据导致全站数据先被清空。
export function parseChatBackup(value: unknown): ChatBackup {
  if (value === undefined) return { threads: {}, reads: {} };
  if (!value || typeof value !== 'object') throw new Error('私信备份格式无效');
  const data = value as ChatBackup;
  if (!data.threads || !data.reads || typeof data.threads !== 'object' || typeof data.reads !== 'object' || Array.isArray(data.threads) || Array.isArray(data.reads)) throw new Error('私信备份格式无效');
  for (const [key, messages] of Object.entries(data.threads)) {
    const participants: unknown = JSON.parse(key);
    if (!Array.isArray(participants) || participants.length !== 2 || participants.some((name) => typeof name !== 'string' || !name) || participants[0] === participants[1] || conversationId(participants[0], participants[1]) !== key || !Array.isArray(messages)) throw new Error('私信会话格式无效');
    const ids = new Set<string>();
    messages.forEach((message, index) => {
      if (!message || message.seq !== index + 1 || typeof message.id !== 'string' || !CHAT_ID.test(message.id) || !participants.includes(message.sender) || !participants.includes(message.recipient) || message.sender === message.recipient || typeof message.text !== 'string' || !message.text.trim() || message.text.length > CHAT_TEXT_LIMIT || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0 || !Number.isFinite(new Date(message.createdAt).getTime()) || ids.has(`${message.sender}:${message.id}`)) throw new Error('私信消息格式无效');
      ids.add(`${message.sender}:${message.id}`);
    });
  }
  for (const [key, cursor] of Object.entries(data.reads)) {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || !data.threads[parsed[0]] || !JSON.parse(parsed[0]).includes(parsed[1]) || typeof cursor !== 'string' || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) > data.threads[parsed[0]].length) throw new Error('私信已读位置无效');
  }
  return data;
}

// 所有适配器执行同一脚本：消息去重、序号、已读位置和在线状态转换均原子完成。
export const SOCIAL_SCRIPT = `
local command = ARGV[1]
local p = cjson.decode(ARGV[2])
local function decode(value) if value then return cjson.decode(value) end return nil end
local function list(key, first, last)
  local result = {}
  for _, value in ipairs(redis.call('LRANGE', key, first, last)) do table.insert(result, cjson.decode(value)) end
  return result
end
local function object(key)
  local flat = redis.call('HGETALL', key)
  local result = {}
  for i=1,#flat,2 do result[flat[i]] = flat[i+1] end
  return result
end
local function thread(key) return 'chat:thread:' .. key end
local function dedup(key) return 'chat:dedup:' .. key end
local function readkey(key, user) return cjson.encode({key,user}) end
if command == 'presence' then
  local now = p.now
  local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)
  for _, id in ipairs(expired) do redis.call('ZREM', KEYS[3], id) redis.call('HDEL', KEYS[4], id) end
  local ok = true
  if p.action == 'join' then
    redis.call('HSET', KEYS[4], p.connection, p.user)
    redis.call('ZADD', KEYS[3], now + p.lease, p.connection)
  elseif p.action == 'heartbeat' then
    if redis.call('HGET', KEYS[4], p.connection) == p.user then redis.call('ZADD', KEYS[3], now + p.lease, p.connection) else ok = false end
  elseif p.action == 'leave' then
    if redis.call('HGET', KEYS[4], p.connection) == p.user then redis.call('ZREM', KEYS[3], p.connection) redis.call('HDEL', KEYS[4], p.connection) end
  end
  local active = {}
  local leases = redis.call('ZRANGE', KEYS[3], 0, -1, 'WITHSCORES')
  for i=1,#leases,2 do
    local user = redis.call('HGET', KEYS[4], leases[i])
    if user then active[user] = math.max(active[user] or 0, tonumber(leases[i+1])) end
  end
  local states = object(KEYS[5])
  if p.action == 'join' and not states[p.user] then states[p.user] = cjson.encode({online=false,version=0,untilAt=0}) end
  local changes = {}
  for user, raw in pairs(states) do
    local state = cjson.decode(raw)
    local wasOnline = state.online and state.untilAt > now
    if state.online and not wasOnline then
      state.online = false state.version = redis.call('INCR', KEYS[6])
      table.insert(changes,{username=user,online=false,version=state.version})
    end
    if active[user] then state.untilAt = active[user] + p.grace
    elseif p.action == 'leave' and p.user == user then state.untilAt = math.min(state.untilAt, now + p.grace) end
    local online = state.untilAt > now
    if online ~= state.online then
      state.online = online state.version = redis.call('INCR', KEYS[6])
      table.insert(changes,{username=user,online=online,version=state.version})
    end
    redis.call('HSET', KEYS[5], user, cjson.encode(state))
  end
  return cjson.encode({ok=ok,changes=changes})
elseif command == 'send' then
  local key = p.key
  local requestId = p.user .. ':' .. p.id
  local previous = redis.call('HGET', dedup(key), requestId)
  if previous then return previous end
  local message = {seq=redis.call('LLEN',thread(key))+1,id=p.id,sender=p.user,recipient=p.peer,text=p.text,createdAt=p.now}
  local raw = cjson.encode(message)
  redis.call('RPUSH',thread(key),raw)
  redis.call('HSET',dedup(key),requestId,raw)
  redis.call('SADD',KEYS[1],key)
  return raw
elseif command == 'history' then
  local latest = redis.call('LLEN',thread(p.key))
  local cursor = tonumber(redis.call('HGET',KEYS[2],readkey(p.key,p.user)) or '0')
  local last = p.before and math.min(p.before-2,latest-1) or latest-1
  local first = p.after and p.after or math.max(0,last-49)
  if not p.before and not p.after then first = math.min(first,cursor) end
  if not p.before then last = math.min(last,first+99) end
  local messages = {}
  if last >= first and last >= 0 then messages = list(thread(p.key),first,last) end
  return cjson.encode({messages=messages,latest=latest,read=cursor})
elseif command == 'read' then
  local key = readkey(p.key,p.user)
  local previous = tonumber(redis.call('HGET',KEYS[2],key) or '0')
  local cursor = math.max(previous,math.min(p.seq,redis.call('LLEN',thread(p.key))))
  redis.call('HSET',KEYS[2],key,tostring(cursor))
  return cjson.encode({read=cursor})
elseif command == 'overview' then
  local result = {}
  for _, peer in ipairs(p.peers) do
    local state = decode(redis.call('HGET',KEYS[5],peer.username)) or {online=false,version=0,untilAt=0}
    local latest = redis.call('LLEN',thread(peer.key))
    local cursor = tonumber(redis.call('HGET',KEYS[2],readkey(peer.key,p.user)) or '0')
    local unread = 0
    for _, message in ipairs(list(thread(peer.key),cursor,-1)) do if message.sender ~= p.user then unread = unread + 1 end end
    local last = redis.call('LINDEX',thread(peer.key),-1)
    table.insert(result,{username=peer.username,online=state.online and state.untilAt>p.now,version=state.version,latest=latest,unread=unread,lastMessage=decode(last)})
  end
  return cjson.encode(result)
elseif command == 'export' then
  local threads = {}
  for _, key in ipairs(redis.call('SMEMBERS',KEYS[1])) do threads[key] = list(thread(key),0,-1) end
  return cjson.encode({threads=threads,reads=object(KEYS[2])})
elseif command == 'restore' then
  for key, messages in pairs(p.threads) do
    redis.call('SADD',KEYS[1],key)
    for _, message in ipairs(messages) do
      local raw = cjson.encode(message)
      redis.call('RPUSH',thread(key),raw)
      redis.call('HSET',dedup(key),message.sender .. ':' .. message.id,raw)
    end
  end
  for key, cursor in pairs(p.reads) do redis.call('HSET',KEYS[2],key,cursor) end
  return 'true'
elseif command == 'delete-user' then
  for _, key in ipairs(redis.call('SMEMBERS',KEYS[1])) do
    local members = cjson.decode(key)
    if members[1] == p.user or members[2] == p.user then
      redis.call('DEL',thread(key),dedup(key))
      redis.call('SREM',KEYS[1],key)
      redis.call('HDEL',KEYS[2],readkey(key,members[1]),readkey(key,members[2]))
    end
  end
  local owners = redis.call('HGETALL',KEYS[4])
  for i=1,#owners,2 do if owners[i+1] == p.user then redis.call('ZREM',KEYS[3],owners[i]) redis.call('HDEL',KEYS[4],owners[i]) end end
  redis.call('HDEL',KEYS[5],p.user)
  return 'true'
elseif command == 'clear' then
  for _, key in ipairs(redis.call('SMEMBERS',KEYS[1])) do redis.call('DEL',thread(key),dedup(key)) end
  for _, key in ipairs(KEYS) do redis.call('DEL',key) end
  return 'true'
end
return redis.error_reply('Unknown social command')
`;
