import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { openDb } from '../db.ts';
import { extractMemories } from '../extract.ts';
import { DEFAULT_RECALL, memoryContext, rankFacts } from '../memories.ts';
import { ollamaEmbed, ollamaJson } from '../ollama.ts';
import { MARK_END, MARK_START, searchAllMessages } from '../search.ts';
import { deleteUserSessions } from '../sessions.ts';
import {
  createUser,
  deleteUser,
  findUser,
  listUsers,
  nameOf,
  setDisplayName,
  setDisabled,
  setPassword,
  validatePassword,
  type User,
} from '../users.ts';
import * as admin from './admin.ts';
import {
  ask,
  closeInput,
  confirm,
  editText,
  interactive,
  localTime,
  page,
  pause,
  pick,
  previewCommand,
  type Choice,
} from './io.ts';

const USAGE = `hearth: admin console for the hearth database

Run with no arguments for the interactive menu (fzf; numbered prompts when piped).

  hearth users    list | add <user> | passwd <user> | name <user> [display name]
                  | disable <user> | enable <user> | delete <user>
  hearth chats    list [user] | show <id> | search <text> | export <id> [file] | rename <id> [title]
                  | delete <id>
  hearth messages edit <id> [text] | delete <id>
  hearth memories list [user] | add <user> <profile|fact> [text] | edit <id> [text]
                  | kind <id> <profile|fact> | delete <id>
                  | extract <chat-id>    run memory extraction on a chat now
                  | recall <user> <text> show what a message would recall, with scores
  hearth sessions list [user] | revoke <id-prefix> | revoke-user <user> | purge
  hearth db       info | check | backup [file] | vacuum | shell

Deletes ask for confirmation; add --yes to skip it. Text left off the command line
opens $EDITOR (or is read from stdin when piped).

Database: ${config.dbPath}`;

class CliError extends Error {}
const fail = (message: string): never => {
  throw new CliError(message);
};

const db = openDb(config.dbPath);

function requireUser(username: string | undefined): User {
  if (!username) fail('A username is required.');
  return findUser(db, username!) ?? fail(`No user "${username}".`);
}

function requireId(value: string | undefined, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`${what} id must be a positive number.`);
  return n;
}

const requireChat = (id: number) => admin.getConversation(db, id) ?? fail(`No chat ${id}.`);
const requireMessage = (id: number) => admin.getMessage(db, id) ?? fail(`No message ${id}.`);
const requireMemory = (id: number) => admin.getMemory(db, id) ?? fail(`No memory ${id}.`);

function requireKind(kind: string | undefined): string {
  if (!kind || !(admin.MEMORY_KINDS as readonly string[]).includes(kind)) fail('Kind must be "profile" or "fact".');
  return kind!;
}

async function sure(question: string, yes: boolean): Promise<boolean> {
  if (yes || (await confirm(question))) return true;
  console.log('Cancelled.');
  return false;
}

async function askNewPassword(): Promise<string> {
  for (;;) {
    const password = (await ask('Password: ', true)) ?? fail('Cancelled.');
    const problem = validatePassword(password);
    if (problem) {
      if (!interactive) fail(problem);
      console.error(problem);
      continue;
    }
    if ((await ask('Confirm password: ', true)) === password) return password;
    if (!interactive) fail('Passwords did not match.');
    console.error('Passwords did not match.');
  }
}

// ── users ──────────────────────────────────────────────────────────────────────
function usersTable(): string {
  const users = listUsers(db);
  if (users.length === 0) return 'No users yet. Add one with: hearth users add <username>';
  const rows = users.map((u) =>
    [
      u.username.padEnd(20),
      (u.display_name ?? '-').padEnd(20),
      (u.disabled ? 'disabled' : 'active').padEnd(9),
      String(u.sessions).padEnd(9),
      localTime(u.created_at),
    ].join(' '),
  );
  const header = ['USERNAME'.padEnd(20), 'NAME'.padEnd(20), 'STATUS'.padEnd(9), 'SESSIONS'.padEnd(9), 'CREATED'];
  return [header.join(' '), ...rows].join('\n');
}

function userSummary(username: string): string {
  const u = requireUser(username);
  const n = (sql: string) => (db.prepare(sql).get(u.id) as { n: number }).n;
  return [
    `${u.username}  (${u.disabled ? 'DISABLED' : 'active'})`,
    `Display name: ${u.display_name ?? '(none; uses the username)'}`,
    `Created ${localTime(u.created_at)}`,
    '',
    `  chats      ${n('SELECT count(*) AS n FROM conversations WHERE user_id = ?')}`,
    `  memories   ${n('SELECT count(*) AS n FROM memories WHERE user_id = ?')}`,
    `  sessions   ${n('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND expires_at > unixepoch() * 1000')}`,
  ].join('\n');
}

async function userAdd(username: string | undefined): Promise<void> {
  if (!username) username = (await ask('New username: '))?.trim() || fail('Cancelled.');
  if (findUser(db, username)) fail(`User "${username}" already exists.`);
  await createUser(db, username, await askNewPassword());
  console.log(`Created user "${username}".`);
}

async function userPasswd(username: string | undefined): Promise<void> {
  const u = requireUser(username);
  await setPassword(db, u.username, await askNewPassword());
  console.log(`Password changed for "${u.username}"; their sessions were signed out.`);
}

async function userName(username: string | undefined, name: string | undefined): Promise<void> {
  const u = requireUser(username);
  if (name === undefined) {
    console.log(`Current display name: ${u.display_name ?? '(none)'}`);
    name = (await ask('New display name (blank = use the username): ')) ?? fail('Cancelled.');
  }
  setDisplayName(db, u.username, name!);
  const updated = requireUser(u.username);
  console.log(updated.display_name ? `"${u.username}" is now called "${updated.display_name}".` : `"${u.username}" uses their username again.`);
}

function userSetDisabled(username: string | undefined, disabled: boolean): void {
  const u = requireUser(username);
  setDisabled(db, u.username, disabled);
  console.log(disabled ? `Disabled "${u.username}" and signed out their sessions.` : `Enabled "${u.username}".`);
}

async function userDelete(username: string | undefined, yes: boolean): Promise<boolean> {
  const u = requireUser(username);
  if (!yes) {
    console.log(`This permanently deletes "${u.username}" and all of their chats and memories.`);
    if ((await ask('Type the username to confirm: ')) !== u.username) {
      console.log('Not deleted.');
      return false;
    }
  }
  deleteUser(db, u.username);
  console.log(`Deleted "${u.username}".`);
  return true;
}

// ── chats and messages ─────────────────────────────────────────────────────────
const chatLabel = (c: admin.ConversationRow) =>
  `#${c.id}  ${c.username}  ·  ${admin.conversationTitle(c)}  ·  ${c.messages} msgs  ·  ${localTime(c.updated_at)}`;

function chatsTable(username?: string): string {
  if (username) requireUser(username);
  const chats = admin.listConversations(db, username);
  return chats.length ? chats.map(chatLabel).join('\n') : 'No chats.';
}

function chatsSearch(text: string | undefined): string {
  if (!text) fail('Give some text to search for.');
  const hits = searchAllMessages(db, text!);
  if (hits.length === 0) return 'No matches.';
  const bold = (s: string) =>
    interactive ? s.replaceAll(MARK_START, '\x1b[1;38;5;213m').replaceAll(MARK_END, '\x1b[0m') : s.replaceAll(MARK_START, '[').replaceAll(MARK_END, ']');
  return hits
    .map((h) => `#${h.conversationId} ${h.username} · ${h.title ?? '(untitled)'} · message ${h.messageId}\n    ${bold(h.snippet)}`)
    .join('\n');
}

const chatText = (id: number) => admin.formatConversation(requireChat(id), admin.listMessages(db, id));

function chatExport(id: number, file: string | undefined): void {
  const text = chatText(id);
  if (!file) {
    process.stdout.write(`${text}\n`);
    return;
  }
  fs.writeFileSync(file, `${text}\n`, { mode: 0o600 });
  console.log(`Wrote chat ${id} to ${path.resolve(file)}.`);
}

async function chatRename(id: number, title: string | undefined): Promise<void> {
  const c = requireChat(id);
  if (!title) {
    console.log(`Current title: ${admin.conversationTitle(c)}`);
    title = (await ask('New title: '))?.trim() || fail('Cancelled.');
  }
  admin.renameConversation(db, id, title);
  console.log(`Renamed chat ${id}.`);
}

async function chatDelete(id: number, yes: boolean): Promise<boolean> {
  const c = requireChat(id);
  if (!(await sure(`Delete chat ${id} "${admin.conversationTitle(c)}" (${c.messages} messages)?`, yes))) return false;
  admin.deleteConversation(db, id);
  console.log(`Deleted chat ${id}.`);
  return true;
}

async function messageEdit(id: number, text: string | undefined): Promise<void> {
  const m = requireMessage(id);
  const next = text ?? (await editText(m.content));
  if (next === undefined || next.trim() === '') fail('Cancelled; message unchanged.');
  if (next === m.content) {
    console.log('No change.');
    return;
  }
  admin.updateMessage(db, id, next!);
  console.log(`Updated message ${id}.`);
}

async function messageDelete(id: number, yes: boolean): Promise<boolean> {
  const m = requireMessage(id);
  const excerpt = m.content.length > 60 ? `${m.content.slice(0, 60)}…` : m.content;
  if (!(await sure(`Delete ${m.role} message ${id}: "${excerpt}"?`, yes))) return false;
  admin.deleteMessage(db, id);
  console.log(`Deleted message ${id}.`);
  return true;
}

// ── memories ───────────────────────────────────────────────────────────────────
const memoryLabel = (m: admin.MemoryRow) => `#${m.id}  ${m.username}  ·  ${m.kind.padEnd(7)}  ·  ${m.content}`;

function memoriesTable(username?: string): string {
  if (username) requireUser(username);
  const rows = admin.listMemories(db, username);
  return rows.length ? rows.map(memoryLabel).join('\n') : 'No memories.';
}

async function memoryAdd(username: string | undefined, kind: string | undefined, text: string | undefined): Promise<void> {
  const u = requireUser(username);
  const k = requireKind(kind);
  const content = (text ?? (await editText('')))?.trim() || fail('Cancelled; nothing added.');
  const id = admin.addMemory(db, u.id, k, content);
  console.log(`Added ${k} memory ${id} for "${u.username}".`);
}

async function memoryEdit(id: number, text: string | undefined): Promise<void> {
  const m = requireMemory(id);
  const next = (text ?? (await editText(m.content)))?.trim();
  if (!next) fail('Cancelled; memory unchanged.');
  if (next === m.content) {
    console.log('No change.');
    return;
  }
  admin.updateMemoryContent(db, id, next!);
  console.log(`Updated memory ${id}.`);
}

function memoryKind(id: number, kind: string | undefined): void {
  requireMemory(id);
  admin.updateMemoryKind(db, id, requireKind(kind));
  console.log(`Memory ${id} is now "${kind}".`);
}

async function memoryDelete(id: number, yes: boolean): Promise<boolean> {
  const m = requireMemory(id);
  if (!(await sure(`Delete memory ${id} (${m.username}): "${m.content}"?`, yes))) return false;
  admin.deleteMemory(db, id);
  console.log(`Deleted memory ${id}.`);
  return true;
}

async function memoryExtract(chatId: number): Promise<void> {
  requireChat(chatId);
  console.log(`Reading chat ${chatId} with ${config.model}…`);
  const r = await extractMemories(
    db,
    chatId,
    ollamaJson(config.ollamaUrl, config.model, config.numCtx),
    ollamaEmbed(config.ollamaUrl, config.embedModel),
  );
  if (r.read === 0) {
    console.log('Nothing new to read in that chat.');
    return;
  }
  const extras = [r.duplicates ? `skipped ${r.duplicates} duplicate(s)` : '', r.named ? 'learned their name' : '']
    .filter(Boolean)
    .map((x) => `, ${x}`)
    .join('');
  console.log(`Read ${r.read} message(s): added ${r.added}, updated ${r.updated}${extras}.`);
  const fromChat = admin.listMemories(db).filter((m) => m.source_conversation_id === chatId);
  if (fromChat.length) console.log(fromChat.map(memoryLabel).join('\n'));
}

async function memoryRecall(username: string | undefined, text: string | undefined): Promise<void> {
  const u = requireUser(username);
  if (!text) fail('Give the message text to recall against.');
  const embed = ollamaEmbed(config.ollamaUrl, config.embedModel);
  const ranked = await rankFacts(db, u.id, text!, embed);
  console.log(`Facts by similarity (recalled at >= ${DEFAULT_RECALL.minScore}, top ${DEFAULT_RECALL.topK}):`);
  for (const f of ranked) console.log(`  ${f.score.toFixed(3)} ${f.score >= DEFAULT_RECALL.minScore ? '✓' : ' '} #${f.id} ${f.content}`);
  if (ranked.length === 0) console.log('  (no facts)');
  console.log('\nIn the system prompt:\n');
  const { stable, recalled } = await memoryContext(db, { id: u.id, name: nameOf(u) }, text!, embed, 800);
  console.log(stable || '(no memories)');
  console.log(`\nAttached to the message itself:\n\n${recalled || '(nothing recalled)'}`);
}

// ── sessions ───────────────────────────────────────────────────────────────────
function sessionsTable(username?: string): string {
  if (username) requireUser(username);
  const rows = admin.listSessions(db, username);
  return rows.length ? rows.map(admin.formatSession).join('\n') : 'No sessions.';
}

function sessionRevoke(prefix: string | undefined): void {
  if (!prefix || prefix.length < 6) fail('Give at least the first 6 characters of the session id.');
  const ids = admin.findSessionIds(db, prefix!);
  if (ids.length === 0) fail(`No session starting "${prefix}".`);
  if (ids.length > 1) fail(`"${prefix}" matches ${ids.length} sessions; give more characters.`);
  admin.revokeSession(db, ids[0]!);
  console.log(`Revoked session ${ids[0]!.slice(0, 12)}.`);
}

function sessionsRevokeUser(username: string | undefined): void {
  const u = requireUser(username);
  deleteUserSessions(db, u.id);
  console.log(`Signed "${u.username}" out everywhere.`);
}

// ── database ───────────────────────────────────────────────────────────────────
async function dbBackup(file: string | undefined): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = path.resolve(file ?? path.join(path.dirname(config.dbPath), 'backups', `hearth-${stamp}.db`));
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  await db.backup(dest);
  fs.chmodSync(dest, 0o600);
  console.log(`Backed up to ${dest}.`);
}

function dbCheck(): void {
  const result = admin.integrityCheck(db);
  console.log(result.length === 1 && result[0] === 'ok' ? 'Integrity check: ok' : `Integrity check FAILED:\n${result.join('\n')}`);
}

function dbVacuum(): void {
  db.exec('VACUUM');
  console.log('Vacuumed.');
}

function dbShell(): void {
  if (spawnSync('sqlite3', ['-version']).status !== 0) fail('sqlite3 is not installed (sudo apt install sqlite3).');
  spawnSync('sqlite3', [config.dbPath], { stdio: 'inherit' });
}

// ── interactive menus ──────────────────────────────────────────────────────────
const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

// Runs one menu action; a failure is reported and the menu carries on.
async function attempt(action: () => unknown): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
  await pause();
}

async function mainMenu(): Promise<void> {
  for (;;) {
    const choice = await pick(`hearth admin · ${config.dbPath}`, [
      { key: 'users', label: `users      (${count('users')})` },
      { key: 'chats', label: `chats      (${count('conversations')})` },
      { key: 'memories', label: `memories   (${count('memories')})` },
      { key: 'sessions', label: `sessions   (${count('sessions')})` },
      { key: 'db', label: 'database   info · check · backup · vacuum · sqlite3 shell' },
      { key: 'quit', label: 'quit' },
    ]);
    if (choice === 'users') await usersMenu();
    else if (choice === 'chats') await chatsMenu();
    else if (choice === 'memories') await memoriesMenu();
    else if (choice === 'sessions') await sessionsMenu();
    else if (choice === 'db') await dbMenu();
    else return;
  }
}

async function usersMenu(): Promise<void> {
  for (;;) {
    const users: Choice[] = listUsers(db).map((u) => ({
      key: u.username,
      label: `${u.username}${u.disabled ? '  (disabled)' : ''}`,
    }));
    const choice = await pick('Users', [{ key: '+add', label: '+ add a user' }, ...users], previewCommand('user'));
    if (!choice) return;
    if (choice === '+add') await attempt(() => userAdd(undefined));
    else await userMenu(choice);
  }
}

async function userMenu(username: string): Promise<void> {
  for (;;) {
    const u = findUser(db, username);
    if (!u) return;
    const choice = await pick(`User: ${u.username}`, [
      { key: 'view', label: 'view summary' },
      { key: 'chats', label: 'chats' },
      { key: 'memories', label: 'memories' },
      { key: 'name', label: `display name  (${u.display_name ?? 'none'})` },
      { key: 'passwd', label: 'change password' },
      { key: 'toggle', label: u.disabled ? 'enable (allow login)' : 'disable (block login, keep data)' },
      { key: 'signout', label: 'sign out everywhere' },
      { key: 'delete', label: 'DELETE user and all their data' },
    ]);
    if (!choice) return;
    if (choice === 'view') await attempt(() => page(userSummary(username)));
    else if (choice === 'chats') await chatsMenu(username);
    else if (choice === 'memories') await memoriesMenu(username);
    else if (choice === 'name') await attempt(() => userName(username, undefined));
    else if (choice === 'passwd') await attempt(() => userPasswd(username));
    else if (choice === 'toggle') await attempt(() => userSetDisabled(username, !u.disabled));
    else if (choice === 'signout') await attempt(() => sessionsRevokeUser(username));
    else if (choice === 'delete') {
      let deleted = false;
      await attempt(async () => (deleted = await userDelete(username, false)));
      if (deleted) return;
    }
  }
}

async function chatsMenu(username?: string): Promise<void> {
  for (;;) {
    const chats = admin.listConversations(db, username).map((c) => ({ key: String(c.id), label: chatLabel(c) }));
    if (chats.length === 0) {
      console.log(username ? `"${username}" has no chats.` : 'No chats yet.');
      await pause();
      return;
    }
    const choice = await pick(username ? `Chats: ${username}` : 'Chats', chats, previewCommand('chat'));
    if (!choice) return;
    await chatMenu(Number(choice));
  }
}

async function chatMenu(id: number): Promise<void> {
  for (;;) {
    const c = admin.getConversation(db, id);
    if (!c) return;
    const choice = await pick(`Chat #${id}: ${admin.conversationTitle(c)}`, [
      { key: 'view', label: 'read' },
      { key: 'messages', label: 'edit or delete a message' },
      { key: 'rename', label: 'rename' },
      { key: 'export', label: 'export to a markdown file' },
      { key: 'delete', label: 'DELETE chat' },
    ]);
    if (!choice) return;
    if (choice === 'view') await attempt(() => page(chatText(id)));
    else if (choice === 'messages') await messagesMenu(id);
    else if (choice === 'rename') await attempt(() => chatRename(id, undefined));
    else if (choice === 'export') {
      await attempt(async () => {
        const file = (await ask(`File [hearth-chat-${id}.md]: `))?.trim() || `hearth-chat-${id}.md`;
        chatExport(id, file);
      });
    } else if (choice === 'delete') {
      let deleted = false;
      await attempt(async () => (deleted = await chatDelete(id, false)));
      if (deleted) return;
    }
  }
}

async function messagesMenu(conversationId: number): Promise<void> {
  for (;;) {
    const messages = admin.listMessages(db, conversationId).map((m) => ({
      key: String(m.id),
      label: `#${m.id}  ${m.role.padEnd(9)}  ${m.content}`,
    }));
    const id = await pick('Messages (pick one to edit or delete)', messages, previewCommand('message'));
    if (!id) return;
    const choice = await pick(`Message #${id}`, [
      { key: 'edit', label: 'edit text' },
      { key: 'delete', label: 'DELETE message' },
    ]);
    if (choice === 'edit') await attempt(() => messageEdit(Number(id), undefined));
    else if (choice === 'delete') await attempt(() => messageDelete(Number(id), false));
  }
}

async function memoriesMenu(username?: string): Promise<void> {
  for (;;) {
    const memories = admin.listMemories(db, username).map((m) => ({ key: String(m.id), label: memoryLabel(m) }));
    const choice = await pick(
      username ? `Memories: ${username}` : 'Memories',
      [{ key: '+add', label: '+ add a memory' }, ...memories],
      previewCommand('memory'),
    );
    if (!choice) return;
    if (choice === '+add') {
      await attempt(async () => {
        const who =
          username ??
          (await pick(
            'Add a memory for which user?',
            listUsers(db).map((u) => ({ key: u.username, label: u.username })),
          ));
        if (!who) return;
        const kind = await pick('Kind', [
          { key: 'fact', label: 'fact     (recalled when relevant)' },
          { key: 'profile', label: 'profile  (always included)' },
        ]);
        if (kind) await memoryAdd(who, kind, undefined);
      });
    } else await memoryMenu(Number(choice));
  }
}

async function memoryMenu(id: number): Promise<void> {
  for (;;) {
    const m = admin.getMemory(db, id);
    if (!m) return;
    const other = m.kind === 'fact' ? 'profile' : 'fact';
    const choice = await pick(`Memory #${id} (${m.username}, ${m.kind})`, [
      { key: 'edit', label: 'edit text' },
      { key: 'kind', label: `make it a ${other} memory` },
      { key: 'delete', label: 'DELETE memory' },
    ]);
    if (!choice) return;
    if (choice === 'edit') await attempt(() => memoryEdit(id, undefined));
    else if (choice === 'kind') await attempt(() => memoryKind(id, other));
    else if (choice === 'delete') {
      let deleted = false;
      await attempt(async () => (deleted = await memoryDelete(id, false)));
      if (deleted) return;
    }
  }
}

async function sessionsMenu(): Promise<void> {
  for (;;) {
    const sessions = admin.listSessions(db).map((s) => ({ key: s.id, label: admin.formatSession(s) }));
    const choice = await pick('Sessions (pick one to revoke)', [
      { key: '+purge', label: '+ purge expired sessions' },
      ...sessions,
    ]);
    if (!choice) return;
    if (choice === '+purge') await attempt(() => console.log(`Removed ${admin.purgeExpiredSessions(db)} expired session(s).`));
    else if (await confirm('Revoke this session?')) await attempt(() => sessionRevoke(choice));
  }
}

async function dbMenu(): Promise<void> {
  for (;;) {
    const choice = await pick('Database', [
      { key: 'info', label: 'info (size, row counts)' },
      { key: 'check', label: 'integrity check' },
      { key: 'backup', label: 'back up now' },
      { key: 'vacuum', label: 'vacuum (reclaim space)' },
      { key: 'shell', label: 'open a sqlite3 shell' },
    ]);
    if (!choice) return;
    if (choice === 'info') await attempt(() => console.log(admin.dbInfo(db, config.dbPath)));
    else if (choice === 'check') await attempt(dbCheck);
    else if (choice === 'backup') await attempt(() => dbBackup(undefined));
    else if (choice === 'vacuum') await attempt(dbVacuum);
    else if (choice === 'shell') await attempt(dbShell);
  }
}

// fzf's preview pane runs `hearth _preview <kind> <key>` for the highlighted line.
function preview(kind: string | undefined, key: string | undefined): void {
  if (!key || key.startsWith('+')) return;
  if (kind === 'user') console.log(userSummary(key));
  else if (kind === 'chat') console.log(chatText(Number(key)));
  else if (kind === 'message') console.log(requireMessage(Number(key)).content);
  else if (kind === 'memory') console.log(admin.formatMemory(requireMemory(Number(key))));
}

// ── dispatch ───────────────────────────────────────────────────────────────────
async function run(argv: string[]): Promise<void> {
  const yes = argv.includes('--yes');
  const [group, action, a, b, ...rest] = argv.filter((x) => x !== '--yes');
  const text = (...parts: (string | undefined)[]) => {
    const joined = parts.filter((p) => p !== undefined).join(' ');
    return joined === '' ? undefined : joined;
  };

  switch (group) {
    case undefined:
      return mainMenu();
    case 'help':
    case '--help':
    case '-h':
      return console.log(USAGE);
    case '_preview':
      return preview(action, a);
    case 'users':
      if (!action || action === 'list') return console.log(usersTable());
      if (action === 'add') return userAdd(a);
      if (action === 'passwd') return userPasswd(a);
      if (action === 'name') return userName(a, b === undefined ? undefined : (text(b, ...rest) ?? ''));
      if (action === 'disable' || action === 'enable') return userSetDisabled(a, action === 'disable');
      if (action === 'delete') return void (await userDelete(a, yes));
      break;
    case 'chats':
      if (!action || action === 'list') return console.log(chatsTable(a));
      if (action === 'show') return page(chatText(requireId(a, 'Chat')));
      if (action === 'search') return console.log(chatsSearch(text(a, b, ...rest)));
      if (action === 'export') return chatExport(requireId(a, 'Chat'), b);
      if (action === 'rename') return chatRename(requireId(a, 'Chat'), text(b, ...rest));
      if (action === 'delete') return void (await chatDelete(requireId(a, 'Chat'), yes));
      break;
    case 'messages':
      if (action === 'edit') return messageEdit(requireId(a, 'Message'), text(b, ...rest));
      if (action === 'delete') return void (await messageDelete(requireId(a, 'Message'), yes));
      break;
    case 'memories':
      if (!action || action === 'list') return console.log(memoriesTable(a));
      if (action === 'add') return memoryAdd(a, b, text(...rest));
      if (action === 'edit') return memoryEdit(requireId(a, 'Memory'), text(b, ...rest));
      if (action === 'kind') return memoryKind(requireId(a, 'Memory'), b);
      if (action === 'delete') return void (await memoryDelete(requireId(a, 'Memory'), yes));
      if (action === 'extract') return memoryExtract(requireId(a, 'Chat'));
      if (action === 'recall') return memoryRecall(a, text(b, ...rest));
      break;
    case 'sessions':
      if (!action || action === 'list') return console.log(sessionsTable(a));
      if (action === 'revoke') return sessionRevoke(a);
      if (action === 'revoke-user') return sessionsRevokeUser(a);
      if (action === 'purge') return console.log(`Removed ${admin.purgeExpiredSessions(db)} expired session(s).`);
      break;
    case 'db':
      if (!action || action === 'info') return console.log(admin.dbInfo(db, config.dbPath));
      if (action === 'check') return dbCheck();
      if (action === 'backup') return dbBackup(a);
      if (action === 'vacuum') return dbVacuum();
      if (action === 'shell') return dbShell();
      break;
  }
  fail(`Unknown command: ${argv.join(' ')}\n\n${USAGE}`);
}

run(process.argv.slice(2))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    closeInput();
    db.close();
  });
