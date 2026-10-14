"""Export the reviewed current setup index; no credentials or discovery side effects."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
source = ROOT / "docs" / "cmdb" / "current-setup.json"
if __name__ == "__main__":
    data = json.loads(source.read_text())
    print(json.dumps(data, indent=2, sort_keys=True))
