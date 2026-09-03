#!/usr/bin/env python3
"""Fails when the protected OpenAPI/event baseline loses an additive v1 contract."""
import json
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[2]
baseline = json.loads((root / 'docs/api/COMPATIBILITY-BASELINE.json').read_text())
openapi_text = (root / 'docs/openapi.yaml').read_text()
registry = (root / 'docs/events/LIFECYCLE-EVENT-REGISTRY.md').read_text()

paths = set(re.findall(r'^  (/[^:]+):', openapi_text, flags=re.MULTILINE))
missing_paths = [path for path in baseline['openapi_paths'] if path not in paths]
missing_events = [event for event in baseline['lifecycle_events'] if event not in registry]
result = {'valid': not missing_paths and not missing_events, 'missing_paths': missing_paths, 'missing_events': missing_events}
print(json.dumps(result))
sys.exit(0 if result['valid'] else 2)
