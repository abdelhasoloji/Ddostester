<?php
// "My account" — an authenticated-looking dashboard that does a moderate amount
// of origin work (order history aggregation). Uncacheable (per-user), so it is
// another real stress target discovered from the homepage.
require __DIR__ . '/api/_lib.php';

$start = microtime(true);
bench_burn_cpu(80);
$orders = array_slice(bench_catalogue(8000), 0, 10);

bench_json([
    'ok'     => true,
    'user'   => 'user@acme.test',
    'orders' => $orders,
    'tookMs' => round((microtime(true) - $start) * 1000, 1),
    'host'   => gethostname(),
]);
