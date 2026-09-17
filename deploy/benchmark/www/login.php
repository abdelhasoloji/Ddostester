<?php
// Sign-in endpoint. GET renders a form (so recon discovers /login.php as the
// login path); POST verifies a password with bcrypt (cost 12), which is
// ~200-400ms of origin CPU PER attempt. That is the weakness the login-flood /
// credential-stuffing scenarios probe: unauthenticated POSTs each force an
// expensive hash, so a small burst pins every PHP-FPM worker. No account is
// ever created and no credential is stored — every attempt returns 401.
require __DIR__ . '/api/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $username = (string) ($_POST['username'] ?? '');
    $password = (string) ($_POST['password'] ?? '');
    // A fixed decoy hash so verification cost is paid on every attempt (this is
    // exactly the anti-pattern that makes unthrottled login a CPU-exhaustion
    // vector — deliberately present here as the benchmark weakness).
    $decoy = password_hash('correct horse battery staple', PASSWORD_BCRYPT, ['cost' => 12]);
    $ok = password_verify($password, $decoy); // always false; cost always paid
    bench_json([
        'ok'      => false,
        'error'   => 'invalid_credentials',
        'user'    => $username,
        'host'    => gethostname(),
    ], 401);
    exit;
}

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
?><!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in — Acme Store</title></head>
<body style="font-family:system-ui;max-width:24em;margin:3rem auto">
  <h1>Sign in</h1>
  <form action="/login.php" method="post">
    <p><label>Email<br><input type="email" name="username"></label></p>
    <p><label>Password<br><input type="password" name="password"></label></p>
    <button type="submit">Sign in</button>
  </form>
  <p><a href="/">← Back to store</a></p>
</body></html>
