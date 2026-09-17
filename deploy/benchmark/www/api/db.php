<?php
// Product detail backed by a "slow query". Models a DB-bound endpoint: it
// spends most of its time in an I/O-style wait (usleep) that HOLDS the PHP-FPM
// worker without using CPU — the classic way a small connection pool gets
// exhausted while CPU still looks idle. Bounded by ?ms= (default 300, cap 1500).
require __DIR__ . '/_lib.php';

$id = isset($_GET['id']) ? (int) $_GET['id'] : 1;
$ms = isset($_GET['ms']) ? (int) $_GET['ms'] : 300;
if ($ms < 0) { $ms = 0; }
if ($ms > 1500) { $ms = 1500; }

$start = microtime(true);
usleep($ms * 1000);                 // simulated query latency (worker is blocked)
bench_burn_cpu(20);                 // a little result-processing CPU
$catalogue = bench_catalogue(200);
$row = $catalogue[$id % count($catalogue)];

bench_json([
    'ok'      => true,
    'product' => $row,
    'queryMs' => $ms,
    'tookMs'  => round((microtime(true) - $start) * 1000, 1),
    'host'    => gethostname(),
]);
