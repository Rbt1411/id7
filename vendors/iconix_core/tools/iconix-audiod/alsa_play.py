#!/usr/bin/env python3
"""
Iconix Sounds – ALSA-Wiedergabe ohne aplay: Python + ctypes direkt gegen libasound.so.2.

Das Head Unit hat libasound und Python 3.12 (mgu-python), aber kein aplay. Dieses Skript ersetzt aplay:

  alsa_play.py play <gerät> <rate>   liest S16LE-Stereo von stdin und spielt es auf <gerät> ab
  alsa_play.py list [namen...]       gibt JSON aus: alle ALSA-PCM-Namen (+ zusätzliche) und ob sie sich öffnen lassen
  alsa_play.py tone <gerät> [sek]    spielt einen Testton (440 Hz) – zum Ausprobieren von Hand

Ausgaben auf stderr in Zeilen wie aplay (z. B. "underrun!!!"), damit engine.js sie zählt.
Kanonische Quelle: shared/alsa_play.py – Kopie im Tool erzeugt `npm run sync`.
"""
import ctypes
import ctypes.util
import json
import math
import struct
import sys

SND_PCM_STREAM_PLAYBACK = 0
SND_PCM_NONBLOCK = 1
SND_PCM_FORMAT_S16_LE = 2
SND_PCM_ACCESS_RW_INTERLEAVED = 3
EPIPE = 32
ESTRPIPE = 86
EAGAIN = 11


def load_alsa():
    lib, last = None, None
    for n in ['libasound.so.2', 'libasound.so', '/usr/lib/libasound.so.2', '/lib/libasound.so.2']:
        try:
            lib = ctypes.CDLL(n)
            break
        except OSError as e:
            last = e
    if lib is None:
        # find_library ruft ldconfig/gcc auf – auf dem Head Unit (BusyBox) langsam oder nicht vorhanden, daher zuletzt
        try:
            n = ctypes.util.find_library('asound')
            lib = ctypes.CDLL(n) if n else None
        except Exception as e:
            last = e
    if lib is None:
        raise OSError('libasound nicht ladbar: %s' % last)
    lib.snd_strerror.restype = ctypes.c_char_p
    lib.snd_strerror.argtypes = [ctypes.c_int]
    lib.snd_pcm_open.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    lib.snd_pcm_set_params.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                       ctypes.c_int, ctypes.c_uint]
    lib.snd_pcm_writei.restype = ctypes.c_long
    lib.snd_pcm_writei.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    lib.snd_pcm_recover.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    lib.snd_pcm_drain.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_close.argtypes = [ctypes.c_void_p]
    lib.snd_pcm_nonblock.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.snd_device_name_hint.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))]
    lib.snd_device_name_get_hint.restype = ctypes.c_void_p
    lib.snd_device_name_get_hint.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    lib.snd_device_name_free_hint.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    return lib


def err(lib, code):
    try:
        return '%d %s' % (code, lib.snd_strerror(code).decode('utf-8', 'replace'))
    except Exception:
        return str(code)


def open_pcm(lib, dev, rate, latency_us, nonblock=False):
    h = ctypes.c_void_p()
    r = lib.snd_pcm_open(ctypes.byref(h), dev.encode(), SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK if nonblock else 0)
    if r < 0:
        return None, 'open: ' + err(lib, r)
    r = lib.snd_pcm_set_params(h, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 2, int(rate), 1, int(latency_us))
    if r < 0:
        lib.snd_pcm_close(h)
        return None, 'set_params: ' + err(lib, r)
    return h, None


def hint_names(lib):
    out = []
    hints = ctypes.POINTER(ctypes.c_void_p)()
    if lib.snd_device_name_hint(-1, b'pcm', ctypes.byref(hints)) < 0:
        return out
    libc = ctypes.CDLL(None)
    libc.free.argtypes = [ctypes.c_void_p]
    i = 0
    while hints[i]:
        def get(key):
            p = lib.snd_device_name_get_hint(hints[i], key)
            if not p:
                return None
            s = ctypes.cast(p, ctypes.c_char_p).value.decode('utf-8', 'replace')
            libc.free(p)
            return s
        name, desc, io = get(b'NAME'), get(b'DESC'), get(b'IOID')
        if name and io != 'Input':
            out.append({'name': name, 'desc': (desc or '').replace('\n', ' ')[:80]})
        i += 1
    lib.snd_device_name_free_hint(hints)
    return out


def cmd_list(extra=None):
    lib = load_alsa()
    names = hint_names(lib)
    seen = set(n['name'] for n in names)
    # Namen aus BMWs ALSA-Konfiguration (vom Dienst gefunden) mit testen
    for extra_name in (extra or []):
        if extra_name not in seen:
            names.append({'name': extra_name, 'desc': 'aus Konfiguration'})
            seen.add(extra_name)
    # die direkten Geräte der Soundkarte und übliche Namen immer mit testen
    for extra in ['default', 'plughw:0,0', 'plughw:0,1', 'hw:0,0', 'hw:0,1', 'sysdefault', 'dmix']:
        if extra not in seen:
            names.append({'name': extra, 'desc': ''})
            seen.add(extra)
    res = []
    for n in names[:80]:
        h, e = open_pcm(lib, n['name'], 44100, 200000, nonblock=True)
        if h:
            lib.snd_pcm_close(h)
        silent = n['name'] == 'null' or n['name'].startswith('null:')
        res.append({'name': n['name'], 'desc': n['desc'], 'ok': h is not None, 'silent': silent, 'error': e})
    print(json.dumps({'devices': res}))


def cmd_play(dev, rate, latency_us=200000):
    lib = load_alsa()
    h, e = open_pcm(lib, dev, rate, latency_us)
    if not h:
        sys.stderr.write('alsa_play: %s (%s)\n' % (e, dev))
        sys.stderr.flush()
        return 2
    sys.stderr.write('alsa_play: spielt auf %s mit %d Hz\n' % (dev, rate))
    sys.stderr.flush()
    frame_bytes = 4
    chunk = 1024 * frame_bytes
    stdin = sys.stdin.buffer
    pending = b''
    try:
        while True:
            data = stdin.read1(chunk) if hasattr(stdin, 'read1') else stdin.read(chunk)
            if not data:
                break
            data = pending + data
            n = len(data) // frame_bytes
            pending = data[n * frame_bytes:]
            buf = data[:n * frame_bytes]
            off = 0
            while off < n:
                w = lib.snd_pcm_writei(h, buf[off * frame_bytes:], n - off)
                if w < 0:
                    if w in (-EPIPE, -ESTRPIPE):
                        sys.stderr.write('underrun!!!\n')
                        sys.stderr.flush()
                    r = lib.snd_pcm_recover(h, int(w), 1)
                    if r < 0:
                        sys.stderr.write('alsa_play: write: %s\n' % err(lib, r))
                        sys.stderr.flush()
                        return 3
                    continue
                off += w
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        lib.snd_pcm_close(h)
    return 0


def cmd_tone(dev, seconds=2.0):
    lib = load_alsa()
    rate = 44100
    h, e = open_pcm(lib, dev, rate, 200000)
    if not h:
        print('Fehler: %s' % e)
        return 2
    frames = int(rate * seconds)
    data = b''.join(struct.pack('<hh', int(8000 * math.sin(2 * math.pi * 440 * i / rate)),
                                int(8000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(frames))
    off = 0
    while off < frames:
        w = lib.snd_pcm_writei(h, data[off * 4:], frames - off)
        if w < 0:
            if lib.snd_pcm_recover(h, int(w), 1) < 0:
                break
            continue
        off += w
    lib.snd_pcm_drain(h)
    lib.snd_pcm_close(h)
    print('ok')
    return 0


if __name__ == '__main__':
    a = sys.argv[1:]
    try:
        if a and a[0] == 'list':
            cmd_list(a[1:])
        elif len(a) >= 3 and a[0] == 'play':
            sys.exit(cmd_play(a[1], int(a[2]), int(a[3]) if len(a) > 3 else 200000))
        elif len(a) >= 2 and a[0] == 'tone':
            sys.exit(cmd_tone(a[1], float(a[2]) if len(a) > 2 else 2.0))
        else:
            sys.stderr.write(__doc__)
            sys.exit(1)
    except OSError as e:
        if a and a[0] == 'list':
            print(json.dumps({'devices': [], 'error': str(e)}))
        else:
            sys.stderr.write('alsa_play: %s\n' % e)
        sys.exit(4)
