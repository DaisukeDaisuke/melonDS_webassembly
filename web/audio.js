// One mixer input per emulator ID, shared by every screen showing that ID.
// The core's SPU resamples to 48000 Hz. The worklet converts to the actual
// AudioContext rate and absorbs delivery jitter without periodically resetting
// scheduled BufferSources (which caused discontinuities).
const processor = `
class MelonAudio extends AudioWorkletProcessor {
 constructor() {
  super(); this.left=new Float32Array(32768); this.right=new Float32Array(32768);
  this.write=0; this.read=0; this.started=false; this.underruns=0; this.dropped=0; this.report=0; this.speed=1; this.received=0;
  this.port.onmessage=({data})=>{
   if(data.clear){this.read=this.write;this.started=false;return;}
   const a=data.samples;if(!a)return; this.received+=a.length/2;
   for(let n=0;n<a.length;n+=2){const p=this.write++&32767;this.left[p]=a[n]/32768;this.right[p]=a[n+1]/32768;}
   if(this.write-this.read>12000){this.dropped+=Math.floor(this.write-this.read-4096);this.read=this.write-4096;}
  };
 }
 process(inputs,outputs) {
  const channels=outputs[0], l=channels[0], r=channels[1];
  if(!l||!r)return true;
  if(!this.started&&this.write-this.read>=4096)this.started=true;
  const base=48000/sampleRate;
  const queued=this.write-this.read;
  // Delivery jitter changes the queued amount, not the sound's pitch.
  // Keep the hardware sample clock fixed even when rendering is overloaded.
  this.speed=1;
  for(let n=0;n<l.length;n++){
   if(this.started&&this.read+1<this.write){
    const at=Math.floor(this.read),f=this.read-at,p=at&32767,q=(at+1)&32767;
    l[n]=this.left[p]+(this.left[q]-this.left[p])*f;
    r[n]=this.right[p]+(this.right[q]-this.right[p])*f;
    this.read+=base*this.speed;
   }else{
    l[n]=r[n]=0;
    if(this.started){this.started=false;this.underruns++;}
   }
  }
  this.report+=l.length;
  if(this.report>=sampleRate){this.report=0;this.port.postMessage({queued:Math.max(0,Math.floor(this.write-this.read)),underruns:this.underruns,dropped:this.dropped,playbackRate:this.speed,receivedFrames:this.received});}
  return true;
 }
}
registerProcessor('melonds-audio',MelonAudio);
`;
export function createAudioBus({ onTargets = () => {}, onChange = () => {} } = {}) {
  let context, ready;
  const enabled = new Set(), nodes = new Map(), metrics = new Map();
  async function prepare() {
    if (!context) {
      context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      const url = URL.createObjectURL(new Blob([processor], { type: 'text/javascript' }));
      ready = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    await context.resume(); await ready;
  }
  function changed() { onTargets([...enabled]); onChange(); }
  return Object.freeze({
    has: id => enabled.has(id),
    async toggle(id) {
      if (enabled.has(id)) { this.disable(id); return false; }
      await prepare();
      const node = new AudioWorkletNode(context, 'melonds-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.onmessage = ({ data }) => metrics.set(id, data);
      node.connect(context.destination); nodes.set(id, node); enabled.add(id); changed(); return true;
    },
    disable(id) {
      enabled.delete(id); const node = nodes.get(id); node?.disconnect(); node?.port.close(); nodes.delete(id); metrics.delete(id); changed();
    },
    flush(id) { nodes.get(id)?.port.postMessage({ clear: true }); },
    push({ instanceId, samples }) {
      const node = nodes.get(instanceId);
      if (!node || !enabled.has(instanceId) || !samples?.length) return;
      // Transfer ownership only once regardless of how many tiles show this ID.
      node.port.postMessage({ samples }, [samples.buffer]);
    },
    stats() { return { sampleRate: context?.sampleRate ?? null, state: context?.state ?? 'closed', instances: [...enabled].map(instanceId => ({ instanceId, ...metrics.get(instanceId) })) }; }
  });
}
