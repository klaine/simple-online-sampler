import type { Project } from '../types'

interface EmbeddedSample {
  id: string
  name: string
  mimeType: string
  base64: string
}

/**
 * Build a self-contained HTML page that can play the sampler project offline.
 * Embeds all samples as base64 data URIs and uses the Web Audio API directly.
 */
export function buildStandaloneHtml(
  project: Project,
  embeddedSamples: EmbeddedSample[],
): string {
  const projectJson = JSON.stringify(project)
  const samplesJson = JSON.stringify(
    embeddedSamples.map((s) => ({ id: s.id, name: s.name, mimeType: s.mimeType, base64: s.base64 })),
  )

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(project.name)} – Standalone Sampler</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;min-height:100vh;padding:16px}
h1{font-size:1.2rem;margin-bottom:12px;color:#7cc5ff}
.info{font-size:0.75rem;color:#888;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;max-width:480px;width:100%}
.pad{aspect-ratio:1;border:none;border-radius:6px;background:#2a2a4a;color:#ccc;font-size:0.65rem;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;transition:background 0.08s;user-select:none;touch-action:none}
.pad:hover{background:#3a3a5a}
.pad.active{background:#4a6fa5}
.pad.empty{opacity:0.3;cursor:default}
.pad .name{font-weight:600;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90%}
.pad .note{font-size:0.55rem;color:#888}
.transport{display:flex;gap:8px;align-items:center;margin:16px 0}
.transport button{background:#2a2a4a;color:#ccc;border:1px solid #444;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:0.8rem}
.transport button:hover{background:#3a3a5a}
.transport button.playing{background:#4a6fa5}
.status{font-size:0.7rem;color:#666;margin-top:8px}
</style>
</head>
<body>
<h1>${escapeHtml(project.name)}</h1>
<div class="info">${project.bpm} BPM · ${project.pads.filter((p) => p.settings.sampleId).length} samples · ${project.sequences.length} patterns</div>
<div class="transport">
<button id="playBtn" onclick="togglePlay()">▶ Play</button>
<select id="patternSelect" onchange="selectPattern(this.value)">
${project.sequences.map((seq, i) => `<option value="${i}">${escapeHtml(seq.name)}</option>`).join('\n')}
</select>
</div>
<div class="grid" id="padGrid"></div>
<div class="status" id="status">Click a pad or press Play. Touch/click to start audio.</div>
<script>
(function(){
  var PROJECT = ${projectJson};
  var SAMPLES = ${samplesJson};

  var audioCtx = null;
  var buffers = {};
  var voices = [];
  var polyphony = PROJECT.polyphony || 32;
  var playing = false;
  var schedulerTimer = null;
  var currentStep = 0;
  var selectedPatternIndex = 0;
  var nextStepTime = 0;

  var midiNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  function midiToName(n){ return midiNames[n%12]+(Math.floor(n/12)-1); }

  function base64ToArrayBuffer(b64){
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for(var i=0;i<len;i++) bytes[i]=bin.charCodeAt(i);
    return bytes.buffer;
  }

  function ensureAudioCtx(){
    if(!audioCtx){
      audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    }
    if(audioCtx.state==='suspended') audioCtx.resume();
    return audioCtx;
  }

  async function loadSamples(){
    ensureAudioCtx();
    for(var i=0;i<SAMPLES.length;i++){
      var s=SAMPLES[i];
      try{
        var ab=base64ToArrayBuffer(s.base64);
        buffers[s.id]=await audioCtx.decodeAudioData(ab);
      }catch(e){console.warn('Failed to decode',s.name,e);}
    }
    document.getElementById('status').textContent='Loaded '+Object.keys(buffers).length+' samples.';
  }

  function evict(){
    while(voices.length>=polyphony){
      var v=voices.shift();
      try{v.source.stop();}catch(e){}
    }
  }

  function playPad(pad, velocity, when){
    var ctx=ensureAudioCtx();
    var sid=pad.settings.sampleId;
    if(!sid||!buffers[sid]) return;
    evict();
    var buf=buffers[sid];
    var source=ctx.createBufferSource();
    source.buffer=buf;
    var semi=(pad.settings.semitones||0)+(pad.settings.fineCents||0)/100;
    source.playbackRate.value=Math.pow(2,semi/12);
    var gain=ctx.createGain();
    gain.gain.value=Math.max(0.001,(pad.settings.gain||1)*velocity);
    source.connect(gain);
    gain.connect(ctx.destination);
    var dur=buf.duration;
    var startOff=Math.max(0,Math.min(dur,pad.settings.trim.start*dur));
    var endOff=Math.max(startOff,Math.min(dur,pad.settings.trim.end*dur));
    var playDur=Math.max(0.01,endOff-startOff);
    var t=when||ctx.currentTime;
    source.start(t,startOff,playDur);
    voices.push({source:source,padId:pad.id});
    source.onended=function(){voices=voices.filter(function(v){return v.source!==source;});};
  }

  function flashPad(padId){
    var el=document.querySelector('[data-pad="'+padId+'"]');
    if(!el) return;
    el.classList.add('active');
    setTimeout(function(){el.classList.remove('active');},120);
  }

  function buildGrid(){
    var grid=document.getElementById('padGrid');
    grid.innerHTML='';
    var pads=PROJECT.pads.filter(function(p){return p.bank===0;});
    pads.sort(function(a,b){return a.slot-b.slot;});
    pads.forEach(function(pad){
      var btn=document.createElement('button');
      btn.className='pad'+(pad.settings.sampleId?'':' empty');
      btn.setAttribute('data-pad',pad.id);
      var sample=SAMPLES.find(function(s){return s.id===pad.settings.sampleId;});
      btn.innerHTML='<span class="name">'+(sample?sample.name:'-')+'</span><span class="note">'+midiToName(pad.midiNote)+'</span>';
      if(pad.settings.sampleId){
        btn.onpointerdown=function(e){
          e.preventDefault();
          ensureAudioCtx();
          playPad(pad,0.8);
          flashPad(pad.id);
        };
      }
      grid.appendChild(btn);
    });
  }

  function getStepDuration(){
    var seq=PROJECT.sequences[selectedPatternIndex];
    var stepsPerBeat=seq.resolution===32?8:4;
    return 60/PROJECT.bpm/stepsPerBeat;
  }

  function scheduleStep(){
    var ctx=audioCtx;
    if(!ctx||!playing) return;
    var seq=PROJECT.sequences[selectedPatternIndex];
    if(!seq) return;
    var events=seq.events.filter(function(ev){return ev.step===currentStep;});
    events.forEach(function(ev){
      var pad=PROJECT.pads.find(function(p){return p.id===ev.padId;});
      if(pad){
        playPad(pad,ev.velocity||0.8,nextStepTime);
        setTimeout(function(){flashPad(pad.id);},Math.max(0,(nextStepTime-ctx.currentTime)*1000));
      }
    });
    currentStep=(currentStep+1)%seq.lengthSteps;
    nextStepTime+=getStepDuration();
  }

  function scheduler(){
    if(!audioCtx||!playing) return;
    while(nextStepTime<audioCtx.currentTime+0.1){
      scheduleStep();
    }
    schedulerTimer=setTimeout(scheduler,25);
  }

  window.togglePlay=function(){
    ensureAudioCtx();
    if(playing){
      playing=false;
      clearTimeout(schedulerTimer);
      document.getElementById('playBtn').textContent='▶ Play';
      document.getElementById('playBtn').classList.remove('playing');
    }else{
      playing=true;
      currentStep=0;
      nextStepTime=audioCtx.currentTime+0.05;
      document.getElementById('playBtn').textContent='■ Stop';
      document.getElementById('playBtn').classList.add('playing');
      scheduler();
    }
  };

  window.selectPattern=function(idx){
    selectedPatternIndex=parseInt(idx,10);
    currentStep=0;
  };

  buildGrid();
  loadSamples();
})();
</script>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
