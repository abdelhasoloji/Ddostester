<?php
// Product search — a realistic origin-bound endpoint: it materialises a
// synthetic catalogue, scans it case-insensitively, and sorts the matches.
// Uncacheable (depends on ?q=), so no edge cache can absorb it — every request
// is real origin CPU. Cost scales with ?rows= (bounded).
require __DIR__ . '/_lib.php';

$q    = isset($_GET['q']) ? (string) $_GET['q'] : '';
$rows = isset($_GET['rows']) ? (int) $_GET['rows'] : 25000;

$start = microtime(true);
$catalogue = bench_catalogue($rows);
$needle = strtolower($q);
$matches = [];
foreach ($catalogue as $row) {
    if ($needle === '' || strpos(strtolower($row['name']), $needle) !== false) {
        $matches[] = $row;
    }
}
usort($matches, fn($a, $b) => $a['price'] <=> $b['price']);
$page = array_slice($matches, 0, 20);

bench_json([
    'ok'       => true,
    'query'    => $q,
    'scanned'  => count($catalogue),
    'matched'  => count($matches),
    'results'  => $page,
    'tookMs'   => round((microtime(true) - $start) * 1000, 1),
    'host'     => gethostname(),
]);
