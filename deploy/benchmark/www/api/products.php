<?php
// Paginated product listing. Builds the catalogue and renders a page of it
// with a little sorting/formatting work. Uncacheable per (category,page).
require __DIR__ . '/_lib.php';

$category = isset($_GET['category']) ? (string) $_GET['category'] : 'all';
$page     = isset($_GET['page']) ? max(1, (int) $_GET['page']) : 1;
$per      = 20;

$start = microtime(true);
$catalogue = bench_catalogue(15000);
usort($catalogue, fn($a, $b) => $b['stock'] <=> $a['stock']);
$slice = array_slice($catalogue, ($page - 1) * $per, $per);

bench_json([
    'ok'       => true,
    'category' => $category,
    'page'     => $page,
    'total'    => count($catalogue),
    'items'    => $slice,
    'tookMs'   => round((microtime(true) - $start) * 1000, 1),
    'host'     => gethostname(),
]);
