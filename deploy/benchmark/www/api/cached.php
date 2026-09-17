<?php
// A deliberately CACHEABLE endpoint. It advertises public cacheability plus the
// cache-status headers recon reads (X-Cache / Age), so the target profiles as
// cache=hit and the cache-oriented scenarios become applicable. On a bare
// origin with no CDN this is the weakness those scenarios probe: cache-busting
// query strings (?_=rand) bypass it and land straight on the origin.
$maxAge = 60;
header('Content-Type: application/json');
header("Cache-Control: public, max-age=$maxAge, s-maxage=$maxAge");
header('X-Cache: HIT');
header('Age: 30');
header('Vary: Accept-Encoding');

echo json_encode([
    'ok'      => true,
    'banner'  => 'Autumn sale — up to 40% off',
    'cache'   => 'public',
    'maxAge'  => $maxAge,
    'ts'      => round(microtime(true) * 1000),
    'host'    => gethostname(),
]);
