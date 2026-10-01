from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import time
# Local QA fixtures only; never used by Pages.
root=Path(__file__).resolve().parents[2]/'site'
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(root),**kwargs)
 def end_headers(self):
  self.send_header('Cache-Control','no-store');super().end_headers()
 def do_POST(self):self.send_response(204);self.end_headers()
 def do_GET(self):
  mode='normal'; route=self.path.split('?')[0]
  if route.startswith('/fixture/'):
   parts=route.split('/',3);mode=parts[2];route='/'+(parts[3] if len(parts)>3 else '')
  if route in ['/','']:route='/index.html'
  if '.' not in route and (root/(route[1:]+'.html')).exists():route+='.html'
  file=root/route[1:]
  if route=='/style.css' and mode=='dark':
   content=file.read_text().replace('@media (prefers-color-scheme: dark)', '@media screen')
   self.send_response(200);self.send_header('Content-Type','text/css');self.end_headers();self.wfile.write(content.encode());return
  if route in ['/start.html','/project-map.html'] and mode=='storage-off':
   content=file.read_text().replace('<script src="hub.config.js">','<script>Object.defineProperty(window,"localStorage",{get(){throw new Error("Storage blocked fixture")}});</script><script src="hub.config.js">')
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(content.encode());return
  if route=='/hub.config.js':
   content=file.read_text()
   override={
   'absent':'delete HUB_CONFIG.overview;delete HUB_CONFIG.onboarding;',
   'disabled':'HUB_CONFIG.overview.enabled=false;HUB_CONFIG.onboarding.enabled=false;',
   'empty':'HUB_CONFIG.overview={enabled:true};HUB_CONFIG.onboarding.steps=[];',
   'scoreboard':'HUB_CONFIG.pipelineScoreboard.enabled=true;',
   'custom':'HUB_CONFIG.onboarding.id="custom";HUB_CONFIG.onboarding.helperName="Navigator";HUB_CONFIG.onboarding.steps=HUB_CONFIG.onboarding.steps.slice(0,2);',
   'no-tracker':'HUB_CONFIG.tracker=null;',
   'hostile':'HUB_CONFIG.overview.places[0].label="<img src=x onerror=alert(1)>";HUB_CONFIG.onboarding.steps[0].body="<script>alert(1)</script>";',
   }.get(mode,'')
   content+='\n'+override
   self.send_response(200);self.send_header('Content-Type','text/javascript');self.end_headers();self.wfile.write(content.encode());return
  if route=='/overview.json':
   if mode=='fail':self.send_error(503);return
   if mode=='slow':time.sleep(9)
   data={'malformed':'{"items":','empty-data':'{"items":[]}', 'missing-time':'{"items":[{"title":"Unknown","summary":"Merged; tests pass"}]}', 'invalid-time':'{"checkedAt":"2026-02-30T00:00:00Z","items":[]}'}.get(mode)
   if data is not None:
    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data.encode());return
  self.path=route
  super().do_GET()
ThreadingHTTPServer(('127.0.0.1',8104),Handler).serve_forever()
