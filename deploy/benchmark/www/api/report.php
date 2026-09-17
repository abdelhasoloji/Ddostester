<?php
// "Sales report" — the most expensive endpoint: sustained origin CPU (default
// ~600ms, cap 2000ms via ?ms=). Models an unbudgeted report/render that a
// single request can pin a worker with. Uncacheable.
require __DIR__ . '/_lib.php';

$ms = isset($_GET['ms']) ? (int) $_GET['ms'] : 600;

$start = microtime(true);
$iters = bench_burn_cpu($ms);
// A little aggregation on top of the raw burn so it looks like real work.
$catalogue = bench_catalogue(10000);
$revenue = 0.0;
foreach ($catalogue as $row) { $revenue += $row['price'] * (1 + ($row['stock'] % 5)); }

bench_json([
    'ok'         => true,
    'reportMs'   => min($ms, 2000),
    'iterations' => $iters,
    'revenue'    => round($revenue, 2),
    'tookMs'     => round((microtime(true) - $start) * 1000, 1),
    'host'       => gethostname(),
]);
