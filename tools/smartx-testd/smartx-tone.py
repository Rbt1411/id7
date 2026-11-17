#!/usr/bin/env python3
"""Conservative, 1.0 second, <4% amplitude stereo sine through exact SmartX PCM."""
import ctypes, math, struct, sys
RATE=48000
DURATION=1.0
LEVEL=1000  # 3% of full scale; head-unit volume can still be high

def main(dev):
    a=ctypes.CDLL('libasound.so.2')
    a.snd_strerror.restype=ctypes.c_char_p
    a.snd_strerror.argtypes=[ctypes.c_int]
    a.snd_pcm_open.argtypes=[ctypes.POINTER(ctypes.c_void_p),ctypes.c_char_p,ctypes.c_int,ctypes.c_int]
    a.snd_pcm_open.restype=ctypes.c_int
    a.snd_pcm_set_params.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_uint,ctypes.c_uint,ctypes.c_int,ctypes.c_uint]
    a.snd_pcm_set_params.restype=ctypes.c_int
    a.snd_pcm_writei.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong]
    a.snd_pcm_writei.restype=ctypes.c_long
    a.snd_pcm_recover.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_int]
    a.snd_pcm_recover.restype=ctypes.c_int
    a.snd_pcm_close.argtypes=[ctypes.c_void_p]
    a.snd_pcm_drain.argtypes=[ctypes.c_void_p]
    p=ctypes.c_void_p()
    rc=a.snd_pcm_open(ctypes.byref(p),dev.encode('utf-8'),0,0)
    if rc<0:raise RuntimeError('snd_pcm_open: '+a.snd_strerror(rc).decode('utf-8','replace'))
    try:
        rc=a.snd_pcm_set_params(p,2,3,2,RATE,1,100000)
        if rc<0: raise RuntimeError('snd_pcm_set_params: '+a.snd_strerror(rc).decode('utf-8','replace'))
        total=int(RATE*DURATION)
        for base in range(0,total,1024):
            n=min(1024,total-base)
            values=[]
            for i in range(base,base+n):
                t=i/RATE
                fade=min(1,t/0.09,(DURATION-t)/0.12)
                sample=int(LEVEL*max(0,fade)*math.sin(2*math.pi*420*t))
                values.append(sample);values.append(sample)
            buf=struct.pack('<'+'h'*(2*n),*values)
            offset=0
            while offset<n:
                payload=ctypes.create_string_buffer(buf[offset*4:])
                wr=a.snd_pcm_writei(p,payload,n-offset)
                if wr<0:
                    rc=a.snd_pcm_recover(p,wr,1)
                    if rc<0:raise RuntimeError('PCM write/recover '+str(wr))
                    continue
                if wr==0:raise RuntimeError('PCM no progress')
                offset+=wr
        a.snd_pcm_drain(p)
    finally:a.snd_pcm_close(p)
    print('1s Testton an SmartX geschrieben (nicht gleichbedeutend mit hoerbarer Ausgabe)',flush=True)
if __name__=='__main__':
    try:main(sys.argv[1])
    except Exception as e:
        print('ERROR: '+str(e),file=sys.stderr,flush=True)
        sys.exit(2)
