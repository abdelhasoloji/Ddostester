from pathlib import Path
import subprocess
base=Path('/var/lib/ddostester-fleet-receiver-20261014-01')
base.mkdir(mode=0o700,exist_ok=True)
if base.stat().st_mode & 0o077:raise RuntimeError("Private operation directory required")
configuration=Path('/etc/nginx/conf.d/shieldtest-fleet-evidence.conf')
if configuration.exists():raise RuntimeError('Existing collector configuration is preserved')
main=Path('/etc/nginx/nginx.conf').read_text()
if 'include /etc/nginx/conf.d/*.conf;' not in main:raise RuntimeError('No verified HTTP configuration include')
conf='''map $http_x_wedos_test $shieldtest_fleet_log {
  default 0;
  ~^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$ 1;
}
log_format shieldtest_fleet escape=json '{"epochSec":"$msec","source":"$remote_addr","status":$status,"trace":"$http_x_wedos_test"}';
access_log /var/log/nginx/shieldtest-fleet.jsonl shieldtest_fleet if=$shieldtest_fleet_log;
'''
(base/'configuration.conf').write_text(conf)
configuration.write_text(conf)
try:
    subprocess.run(['nginx','-t'],check=True,timeout=10)
    log=Path('/var/log/nginx/shieldtest-fleet.jsonl')
    if log.exists() and log.stat().st_size:raise RuntimeError("Existing receiver logs are preserved")
    log.touch(exist_ok=True);log.chmod(0o600)
    subprocess.run(['systemctl','reload','nginx'],check=True,timeout=15)
except BaseException:
    configuration.unlink()
    raise
(base/'installed').touch()
print('Scoped Fleet trace logging installed; no traffic launched')
