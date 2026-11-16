#!/usr/bin/env python3
import json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
manifest=json.loads((ROOT/'mgu-repo.json').read_text())
assert manifest['apps']['build']['output']=='dist/{id}@{version}.tgz'
for app in ('dpf','spritmonitor','iconix_sounds','drive_coach'):
    root_spec=json.loads((ROOT/'apps'/app/'app.json').read_text())
    vendor=('bmrmodz' if app in ('dpf','spritmonitor') else 'nico')
    vendor_spec=json.loads((ROOT/'vendors'/vendor/'apps'/app/'app.json').read_text())
    assert root_spec['id']==app and root_spec['version']==vendor_spec['version'], app
    assert (ROOT/'apps'/app/'icon.png').exists()
    print('APP OK',app,root_spec['version'])
for root in ('tools/iconix-audiod','vendors/nico/tools/iconix-audiod'):
    t=ROOT/root
    config=json.loads((t/'component.json').read_text())
    for f in config['files']:
        assert (t/f['path']).is_file(),str(t/f['path'])
    assert config['version']=='0.5.3'
    print('TOOL OK',root)
prof=json.loads((ROOT/'apps/iconix_sounds/app.json').read_text())
assert any(p[0]=='b57_540d' for x in prof['settings'] if x['key']=='profile' for p in x['options'])
print('ALL REPO STRUCTURE CHECKS PASSED')
