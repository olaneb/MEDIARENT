const { authenticate, createSession, destroySession, destroyUserSessions, passwordProblem, logAudit } = require('../lib/auth');
const { db, hashPassword, verifyPassword } = require('../lib/db');

module.exports = function (router) {
  router.post('/api/auth/login', async (ctx) => {
    const { email, password } = ctx.body;
    if (!email || !password) return ctx.json(400, { error: 'Email and password required' });
    const result = authenticate(email, password);
    if (result.locked) {
      logAudit(null, 'login_locked', 'user', null, { email }, ctx.ip);
      ctx.res.setHeader('Retry-After', String(result.locked * 60));
      return ctx.json(429, { error: `Too many failed attempts. This account is locked for about ${result.locked} minute(s).` });
    }
    const user = result.user;
    if (!user) {
      logAudit(null, 'login_failed', 'user', null, { email }, ctx.ip);
      return ctx.json(401, { error: 'Invalid email or password' });
    }
    const { token, csrf } = createSession(user.id);
    ctx.res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=28800${ctx.secure ? '; Secure' : ''}`);
    logAudit(user.id, 'login_success', 'user', user.id, null, ctx.ip);
    ctx.json(200, {
      user: { id: user.id, full_name: user.full_name, email: user.email, must_change_password: !!user.must_change_password },
      csrf_token: csrf,
    });
  });

  router.post('/api/auth/logout', async (ctx) => {
    if (ctx.session) destroySession(ctx.session.token);
    ctx.res.setHeader('Set-Cookie', `session=; HttpOnly; Path=/; Max-Age=0${ctx.secure ? '; Secure' : ''}`);
    ctx.json(200, { ok: true });
  });

  router.get('/api/auth/me', async (ctx) => {
    if (!ctx.user) return ctx.json(401, { error: 'Not authenticated' });
    let perms = [];
    try { perms = JSON.parse(ctx.user.role_permissions || '[]'); } catch {}
    ctx.json(200, {
      id: ctx.user.id, full_name: ctx.user.full_name, email: ctx.user.email,
      role: ctx.user.role_name, permissions: perms,
      must_change_password: !!ctx.user.must_change_password,
      csrf_token: ctx.session.csrf_token,
    });
  });

  router.post('/api/auth/change-password', async (ctx) => {
    if (!ctx.user) return ctx.json(401, { error: 'Not authenticated' });
    if (!ctx.requireCsrf()) return;
    const { new_password, current_password } = ctx.body;
    // The current password is always required — a hijacked session alone must not be able to take over the account.
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    if (!current_password || !verifyPassword(String(current_password), u.password_salt, u.password_hash)) return ctx.json(400, { error: 'Current password is incorrect' });
    const problem = passwordProblem(new_password);
    if (problem) return ctx.json(400, { error: problem });
    if (new_password === current_password) return ctx.json(400, { error: 'Choose a password different from the current one' });
    const { hash, salt } = hashPassword(new_password);
    destroyUserSessions(ctx.user.id, ctx.session.token);
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?')
      .run(hash, salt, ctx.user.id);
    logAudit(ctx.user.id, 'password_changed', 'user', ctx.user.id, null, ctx.ip);
    ctx.json(200, { ok: true });
  });
};
