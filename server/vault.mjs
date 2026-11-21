import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openWorkspace } from './workspace.mjs'

export const sessionLifetime = 7 * 24 * 60 * 60
export const randomToken = () => randomBytes(32).toString('base64url')
export const digest = (value) => createHash('sha256').update(value).digest('base64url')

export const openVault = ({ dataDir, key }) => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dataDir, 'accounts.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, login TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS providers (
      owner TEXT NOT NULL, id TEXT NOT NULL, profile TEXT NOT NULL, encrypted_key BLOB NOT NULL,
      PRIMARY KEY (owner, id)
    );
    CREATE TABLE IF NOT EXISTS account_avatars (
      owner TEXT PRIMARY KEY, avatar_url TEXT NOT NULL
    );
  `)
  const authData = (owner, profile) =>
    Buffer.from(
      JSON.stringify([owner, profile.id, profile.scope, profile.protocol, profile.baseUrl])
    )

  const encrypt = (owner, profile, secret) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(authData(owner, profile))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  }
  const decrypt = (owner, profile, blob) => {
    const value = Buffer.from(blob)
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
    decipher.setAAD(authData(owner, profile))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  }

  const read = (owner, id) =>
    db
      .prepare('SELECT profile, encrypted_key FROM providers WHERE owner = ? AND id = ?')
      .get(owner, id)
  const list = (owner) =>
    db
      .prepare('SELECT profile FROM providers WHERE owner = ? ORDER BY rowid')
      .all(owner)
      .map(({ profile }) => JSON.parse(profile))
  const remove = (owner, id) =>
    db.prepare('DELETE FROM providers WHERE owner = ? AND id = ?').run(owner, id).changes > 0
  const profileId = (owner, creationId) => {
    const hex = createHash('sha256')
      .update(JSON.stringify([owner, creationId]))
      .digest('hex')
    return (
      'account-' +
      [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
      ].join('-')
    )
  }

  return {
    workspace: openWorkspace(db, { key, dataDir }),
    avatar(owner) {
      return (
        db.prepare('SELECT avatar_url FROM account_avatars WHERE owner = ?').get(owner)
          ?.avatar_url ?? null
      )
    },
    saveAvatar(owner, url) {
      if (url) {
        db.prepare(`
          INSERT INTO account_avatars VALUES (?, ?)
          ON CONFLICT(owner) DO UPDATE SET avatar_url=excluded.avatar_url
        `).run(owner, url)
      } else {
        db.prepare('DELETE FROM account_avatars WHERE owner = ?').run(owner)
      }
    },
    issueSession(owner, login) {
      const now = Date.now()
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now)
      const token = randomToken()
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(
        digest(token),
        owner,
        login,
        now + 1000 * sessionLifetime
      )
      return token
    },
    session(token) {
      return (
        token &&
        db
          .prepare('SELECT owner, login FROM sessions WHERE token_hash = ? AND expires > ?')
          .get(digest(token), Date.now())
      )
    },
    revoke(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token))
    },
    list,
    remove,
    save(owner, values, newKey, id, creationId) {
      // A write transaction keeps connection rotation and the stored Key consistent on retry.
      db.exec('BEGIN IMMEDIATE')
      try {
        const target = id ?? profileId(owner, creationId)
        const existing = read(owner, target)
        if (id && !existing) return null
        if (!id && existing) return JSON.parse(existing.profile)
        if (!existing && list(owner).length >= 40) return { error: 'provider_limit' }
        const previous = existing ? JSON.parse(existing.profile) : null
        const changed =
          previous && (previous.protocol !== values.protocol || previous.baseUrl !== values.baseUrl)
        if ((!existing || changed) && !newKey) return { error: 'key_required' }
        const profile = {
          ...values,
          id: target,
          scope: !previous || changed || newKey ? randomUUID() : previous.scope,
        }
        // Older clients send only model IDs. Keep metadata for IDs they retained.
        for (const field of ['modelNames', 'modelParameters']) {
          if (values[field] === undefined && previous?.[field]) {
            profile[field] = Object.fromEntries(
              Object.entries(previous[field]).filter(([model]) => values.models.includes(model))
            )
          }
        }
        if (values.defaultModel === undefined && previous?.defaultModel) {
          profile.defaultModel = previous.defaultModel
        }
        const secret = newKey || decrypt(owner, previous, existing.encrypted_key)
        db.prepare(`
          INSERT INTO providers VALUES (?, ?, ?, ?)
          ON CONFLICT(owner,id) DO UPDATE SET profile=excluded.profile, encrypted_key=excluded.encrypted_key
        `).run(owner, profile.id, JSON.stringify(profile), encrypt(owner, profile, secret))
        db.exec('COMMIT')
        return profile
      } finally {
        if (db.isTransaction) db.exec('ROLLBACK')
      }
    },
    connection(owner, id, scope) {
      const row = read(owner, id)
      if (!row) return null
      const profile = JSON.parse(row.profile)
      if (scope !== profile.scope) return { changed: true }
      return { ...profile, apiKey: decrypt(owner, profile, row.encrypted_key) }
    },
    close: () => db.close(),
  }
}
