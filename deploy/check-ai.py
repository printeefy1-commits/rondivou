#!/usr/bin/env python3
"""Read-only AI gateway diagnosis from the Rondivou container; synthetic data only."""
import base64
import getpass
import json
import os
from pathlib import Path
import subprocess
import urllib.request

REVISION = '22729f7d28930e3425b6ae102ddffbe956e2cf56'
BASE_URL = 'https://ip-172-31-45-34.tail8fc7b2.ts.net/v1'


def source_module(relative):
    with urllib.request.urlopen('https://raw.githubusercontent.com/printeefy1-commits/rondivou/' + REVISION + '/src/' + relative, timeout=25) as response:
        return response.read(1024 * 1024).decode()


def data_url(source):
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()


def script(key, model, ai_module):
    settings = json.dumps({'AI_API_KEY': key, 'AI_BASE_URL': BASE_URL, 'AI_MODEL': model})
    return 'const config = ' + settings + ';\nconst moduleURL = ' + json.dumps(ai_module) + ';\n' + r'''
const report = {};
const options = { headers: { Authorization: 'Bearer ' + config.AI_API_KEY }, redirect: 'error', signal: AbortSignal.timeout(20000) };
const knownCodes = new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT','ECONNRESET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
function networkError(error) { return error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : knownCodes.has(error.cause?.code) ? error.cause.code : 'network_or_tls_error'; }
try {
  const response = await fetch(config.AI_BASE_URL + '/models', options);
  report.models_http_status = response.status;
  if (response.ok) {
    const body = await response.json();
    report.available_model_count = Array.isArray(body.data) ? body.data.length : null;
    report.model_ids = (body.data || []).slice(0, 15).map(m => typeof m.id === 'string' && /^[a-zA-Z0-9_./:-]{1,150}$/.test(m.id) && !m.id.includes(config.AI_API_KEY) ? m.id : '(omitted)');
  }
} catch (error) { report.models_connection = networkError(error); }
if (report.models_http_status === 401 || report.models_http_status === 403) {
  report.result = 'gateway_authentication_failed';
} else {
  try {
    const { analyze } = await import(moduleURL);
    const request = async (url, init) => {
      let response;
      try { response = await fetch(url, init); }
      catch (error) { report.chat_connection = networkError(error); throw error; }
      report.chat_http_status = response.status;
      try {
        const body = await response.clone().json();
        report.has_choices = Array.isArray(body.choices);
        report.has_api_error = Boolean(body.error);
        const choice = body.choices?.[0];
        report.finish_reason = ['stop','length','tool_calls','content_filter'].includes(choice?.finish_reason) ? choice.finish_reason : choice?.finish_reason == null ? 'missing' : 'other';
        report.has_text_content = typeof choice?.message?.content === 'string';
        if (report.has_text_content) {
          let parsed;
          try { parsed = JSON.parse(choice.message.content); report.content_is_json = true; }
          catch { report.content_is_json = false; report.content_has_markdown_fence = /^\s*```/.test(choice.message.content); }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            report.field_types = Object.fromEntries(['date','time','service','client_name','phone','ambiguous','change_requested','agreement','evidence'].map(k => [k, parsed[k] === null ? 'null' : typeof parsed[k]]));
            report.synthetic_values_match = { date: parsed.date === '2030-10-23', time: parsed.time === '10:00', service: parsed.service === 'balayage' };
            const text = 'Bonjour, je voudrais un balayage le 23 octobre 2030 à 10h.';
            report.evidence_valid = Object.fromEntries(['date','time','service'].map(k => { const e = parsed.evidence?.[k]; return [k, Boolean(e && e.message_id === 'connection-test' && typeof e.quote === 'string' && e.quote.trim() && text.includes(e.quote))]; }));
          }
        }
      } catch { report.chat_body_is_json = false; }
      return response;
    };
    const result = await analyze([{id:'connection-test',direction:'in',sent_at:'2030-10-20T08:00:00Z',text:'Bonjour, je voudrais un balayage le 23 octobre 2030 à 10h.'}], config, request);
    report.validation_passed = true;
    report.synthetic_test_passed = result.date === '2030-10-23' && result.time === '10:00' && result.service === 'balayage' && !result.agreement && result.complete;
  } catch { report.validation_passed = false; }
}
console.log(JSON.stringify(report));
'''


def main():
    if os.geteuid() != 0 or not Path('/opt/rondivou/runtime.env').is_file():
        raise RuntimeError('Run this on the existing Rondivou EC2 using sudo.')
    model = input('Model [Enter for auto]: ').strip() or 'auto'
    key = getpass.getpass('FreeLLMAPI UNIFIED key (hidden): ').strip()
    if not key or any(c.isspace() for c in key):
        raise RuntimeError('Invalid key format.')
    domain = data_url(source_module('domain.js'))
    ai = source_module('ai.js').replace("'./domain.js'", json.dumps(domain))
    print('Read-only probe: one synthetic request; no settings, code, bookings or containers will be changed.', flush=True)
    result = subprocess.run(['docker', 'exec', '-i', 'rondivou', 'node', '--input-type=module', '-'], input=script(key, model, data_url(ai)), text=True, capture_output=True, timeout=100)
    if result.returncode:
        print('Diagnostic could not run in the container. Raw output withheld to protect secrets.')
        return
    try:
        report = json.loads(result.stdout)
    except ValueError:
        print('Unexpected diagnostic output; raw output withheld.')
        return
    print(json.dumps(report, indent=2, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nCancelled. No settings changed.')
    except Exception:
        print('Diagnostic stopped. Check Internet access, Docker and the existing Rondivou deployment. Raw errors withheld; no settings changed.')
