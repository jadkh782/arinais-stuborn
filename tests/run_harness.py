"""Convert a PDF with the real site code in headless Chrome and unpack the result.

Usage:
    pip install playwright && python -m playwright install chromium
    python tests/run_harness.py path/to/slides.pdf out_dir

The script copies public/ + harness.html into a temp folder, serves it locally,
runs the converter exactly like the website does and writes the zip + unpacked
Markdown/images to out_dir.
"""
import base64, io, os, shutil, subprocess, sys, tempfile, time, zipfile
from playwright.sync_api import sync_playwright

here = os.path.dirname(os.path.abspath(__file__))
pdf, out = sys.argv[1], sys.argv[2]

tmp = tempfile.mkdtemp()
shutil.copytree(os.path.join(here, '..', 'public'), tmp, dirs_exist_ok=True)
shutil.copy(os.path.join(here, 'harness.html'), os.path.join(tmp, 'test.html'))
shutil.copy(pdf, os.path.join(tmp, 'sample.pdf'))

port = '8791'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', port, '-d', tmp],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        exe = os.environ.get('CHROME')  # optional: path to a Chrome binary
        b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        pg = b.new_page()
        pg.goto(f'http://localhost:{port}/test.html')
        pg.wait_for_function('window.DONE === true', timeout=300000)
        r = pg.evaluate('window.RESULT')
        b.close()
finally:
    srv.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

if 'error' in r:
    sys.exit(r['error'])
os.makedirs(out, exist_ok=True)
data = base64.b64decode(r['zip'])
open(os.path.join(out, r['name']), 'wb').write(data)
zipfile.ZipFile(io.BytesIO(data)).extractall(os.path.join(out, 'unpacked'))
print(r['stats'], f"{r['ms']} ms")
print(r['slides'])
