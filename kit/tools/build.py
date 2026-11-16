#!/usr/bin/env python3
"""Dispatch builds to each upstream project's own compatible build kit."""
import os,sys,pathlib,subprocess,shutil
ROOT=pathlib.Path(__file__).resolve().parents[2]
VENDOR={'dpf':'bmrmodz','spritmonitor':'bmrmodz','iconix_sounds':'nico'}
def main():
    if len(sys.argv)<2 or sys.argv[1] not in VENDOR:
        sys.exit('Specify app ID: dpf, spritmonitor, iconix_sounds')
    app=sys.argv[1]; root=ROOT/'vendors'/VENDOR[app]
    sdk=ROOT/'oap-sdk'
    vendor_sdk=root/'oap-sdk'
    if sdk.exists() and not vendor_sdk.exists():
        vendor_sdk.symlink_to(sdk.resolve(),target_is_directory=True)
    cmd=[sys.executable,str(root/'kit/tools/build.py'),app]+sys.argv[2:]
    subprocess.run(cmd,cwd=str(root),check=True)
    # Nico's upstream build does not support MGU_OUT, so publish its archive to the Store output.
    if VENDOR[app]=='nico' and os.environ.get('MGU_OUT') and '--preview-only' not in sys.argv:
        import json
        ver=json.loads((root/'apps'/app/'app.json').read_text())['version']
        src=root/'dist'/f'{app}@{ver}.tgz';dest=pathlib.Path(os.environ['MGU_OUT'])/src.name
        dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(src,dest)
if __name__=='__main__':main()
