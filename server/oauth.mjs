import { digest, randomToken, sessionLifetime } from './vault.mjs'

const oauthLifetime = 300

const avatarUrl = (issuer, picture) => {
  if (typeof picture !== 'string' || picture.length > 2048) return null
  try {
    const url = new URL(picture, issuer)
    if (
      url.origin === issuer &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/avatars?\/[^/]+$/.test(url.pathname)
    )
      return url.href
  } catch {
    // An absent or malformed avatar must never prevent login.
  }
  return null
}

export const createOAuth = (config, vault, origin) => {
  const pending = new Map()
  const secure = new URL(origin).protocol === 'https:'
  const prefix = secure ? '__Host-' : ''
  const sessionCookie = prefix + 'aihub-session'
  const stateCookie = prefix + 'aihub-oauth'
  const callback = origin + '/api/account/callback'

  const cookie = (name, value, age) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`

  const fromCookie = (req, name) => {
    const pair = req.headers.cookie
      ?.split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith(name + '='))
    const value = pair?.slice(name.length + 1)
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
  }

  const redirect = (res, location, cookies = []) => {
    if (cookies.length) res.setHeader('Set-Cookie', cookies)
    res.writeHead(303, { Location: location }).end()
  }

  const session = (req) => {
    const found = vault.session(fromCookie(req, sessionCookie))
    return found && config.users.has(found.login.toLowerCase()) ? found : null
  }

  return {
    session,
    login(req, res) {
      const now = Date.now()
      for (const [state, data] of pending) if (data.expires <= now) pending.delete(state)
      pending.delete(fromCookie(req, stateCookie))
      if (pending.size >= 512) return redirect(res, '/?account=unavailable')
      const state = randomToken()
      const verifier = randomToken()
      pending.set(state, { verifier, expires: now + 1000 * oauthLifetime })

      const authorize = new URL('/login/oauth/authorize', config.issuer)
      authorize.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: callback,
        response_type: 'code',
        scope: 'openid profile public-only read:user',
        state,
        code_challenge: digest(verifier),
        code_challenge_method: 'S256',
      }).toString()
      redirect(res, authorize.href, [cookie(stateCookie, state, oauthLifetime)])
    },
    async callback(req, res, params) {
      const state = params.get('state')
      const code = params.get('code')
      const current = state && state === fromCookie(req, stateCookie) ? pending.get(state) : null
      const clear = cookie(stateCookie, '', 0)
      if (!current || current.expires <= Date.now())
        return redirect(res, '/?account=expired', [clear])
      pending.delete(state)
      if (!code || params.has('error')) return redirect(res, '/?account=cancelled', [clear])
      try {
        const tokenResponse = await fetch(config.issuer + '/login/oauth/access_token', {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: callback,
            code,
            code_verifier: current.verifier,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        })
        if (!tokenResponse.ok) return redirect(res, '/?account=unavailable', [clear])
        const token = (await tokenResponse.json()).access_token
        if (typeof token !== 'string' || !token)
          return redirect(res, '/?account=unavailable', [clear])
        const userResponse = await fetch(config.issuer + '/login/oauth/userinfo', {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        })
        if (!userResponse.ok) return redirect(res, '/?account=unavailable', [clear])
        const { sub, preferred_username: login, picture } = await userResponse.json()
        if (
          typeof sub !== 'string' ||
          !sub ||
          typeof login !== 'string' ||
          !config.users.has(login.toLowerCase())
        ) {
          return redirect(res, '/?account=denied', [clear])
        }
        // Gitea tokens are used only for this UserInfo request. The browser gets an app session.
        const owner = JSON.stringify([config.issuer, sub])
        vault.saveAvatar(owner, avatarUrl(config.issuer, picture))
        const tokenForBrowser = vault.issueSession(owner, login)
        vault.revoke(fromCookie(req, sessionCookie))
        redirect(res, '/', [clear, cookie(sessionCookie, tokenForBrowser, sessionLifetime)])
      } catch {
        redirect(res, '/?account=unavailable', [clear])
      }
    },
    logout(req, res) {
      vault.revoke(fromCookie(req, sessionCookie))
      res.setHeader('Set-Cookie', cookie(sessionCookie, '', 0))
    },
  }
}
