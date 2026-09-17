<?php
// Bounded origin-compute endpoint: busy-works for ~?ms= milliseconds then
// returns. Gives the origin a controllable, uncacheable per-request CPU cost so
// a load test can dial in how hard each request hits the origin. The per-request
// ceiling is 2000ms (was 50ms) so the endpoint is a real exhaustion lever
// against the small PHP-FPM pool, while still bounded so it can never hang the
// box indefinitely — the control plane's HARD_CAPS bound total offered load.
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$ms = isset($_GET['ms']) ? (int) $_GET['ms'] : 10;
if ($ms < 0)    { $ms = 0; }
if ($ms > 2000) { $ms = 2000; }   // hard per-request ceiling (bounded, not unlimited)

$start = microtime(true);
$deadline = $start + $ms / 1000.0;
$iters = 0;
while (microtime(true) < $deadline) {
    hash('sha256', (string) $iters);
    $iters++;
}

echo json_encode([
    'ok'         => true,
    'requestedMs'=> $ms,
    'actualMs'   => round((microtime(true) - $start) * 1000, 2),
    'iterations' => $iters,
    'ts'         => round(microtime(true) * 1000),
    'host'       => gethostname(),
]);
