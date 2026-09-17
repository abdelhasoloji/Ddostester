<?php
// Dynamic, uncacheable echo endpoint. Every request is served by the origin
// (no edge cache can absorb it), which is the point of the benchmark: it shows
// what a bare origin does under load. Accepts GET and POST.
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

$body = file_get_contents('php://input');
echo json_encode([
    'ok'      => true,
    'ts'      => round(microtime(true) * 1000),          // ms epoch
    'id'      => bin2hex(random_bytes(8)),
    'method'  => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    'path'    => $_SERVER['REQUEST_URI'] ?? '/api/echo.php',
    'bytesIn' => strlen($body),
    'host'    => gethostname(),
]);
