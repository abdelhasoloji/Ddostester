<?php
// Shared bounded-compute helpers for the benchmark's dynamic endpoints.
//
// The benchmark origin is INTENTIONALLY WEAK (it is the baseline a protected
// edge is measured against), but it is NOT an unbounded amplifier: every
// endpoint's per-request cost is capped in wall-clock so the box degrades and
// recovers under a bounded load test instead of hanging forever. The real
// "weakness" is the tiny PHP-FPM pool (pm.max_children) — a handful of these
// endpoints in flight saturates every worker, so nginx starts returning
// 502/504 and the origin visibly collapses. That is the point of the bench.

const BENCH_MAX_MS = 2000; // hard per-request wall-clock ceiling (any endpoint)

/** Burn CPU on the origin for ~$ms milliseconds (bounded). Returns iterations. */
function bench_burn_cpu(int $ms): int {
    if ($ms < 0) { $ms = 0; }
    if ($ms > BENCH_MAX_MS) { $ms = BENCH_MAX_MS; }
    $deadline = microtime(true) + $ms / 1000.0;
    $iters = 0;
    while (microtime(true) < $deadline) {
        hash('sha256', (string) $iters);
        $iters++;
    }
    return $iters;
}

/** A synthetic product catalogue (deterministic, generated once per request). */
function bench_catalogue(int $n): array {
    if ($n < 1) { $n = 1; }
    if ($n > 50000) { $n = 50000; } // bound memory/CPU
    $rows = [];
    for ($i = 0; $i < $n; $i++) {
        $rows[] = [
            'id'    => $i,
            'name'  => 'Product ' . substr(hash('crc32b', (string) $i), 0, 6) . " widget $i",
            'price' => ($i * 37) % 9973 / 100.0,
            'stock' => ($i * 13) % 500,
        ];
    }
    return $rows;
}

function bench_json($data, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    echo json_encode($data);
}
