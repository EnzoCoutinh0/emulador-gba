import asyncio
from playwright.async_api import async_playwright
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000}, accept_downloads=True)
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type in ('error','warning') and 'ScriptProcessor' not in m.text else None)
        await page.goto('file://' + __import__('os').path.abspath('dist/index.html'))
        print('worker:', await page.evaluate("__emu.workerMode()"))
        await page.set_input_files('#romInput', 'test/build/heavy_thumb.gba'); await page.wait_for_timeout(3000)
        print('1x  :', await page.inner_text('#status'))
        await page.select_option('#ffSpeed', '4'); await page.click('#btnFF'); await page.wait_for_timeout(3000)
        print('4x  :', await page.inner_text('#status'))
        await page.select_option('#ffSpeed', '8'); await page.wait_for_timeout(3000)
        print('8x  :', await page.inner_text('#status'))
        await page.select_option('#ffSpeed', '0'); await page.wait_for_timeout(3000)
        print('máx :', await page.inner_text('#status'))
        await page.click('#btnFF'); await page.wait_for_timeout(2000)
        print('1x  :', await page.inner_text('#status'))
        # save: jogo com flash que grava; estado; exportar
        await page.set_input_files('#romInput', 'test/build/flash_thumb.gba'); await page.wait_for_timeout(3000)
        print('status flash:', await page.inner_text('#status'))
        print('localStorage:', await page.evaluate("Object.keys(localStorage).filter(k=>k.includes('save'))"))
        await page.click('#btnSaveState'); await page.wait_for_timeout(1200); print('toast:', await page.inner_text('#toast'))
        await page.click('#btnLoadState'); await page.wait_for_timeout(1200); print('toast:', await page.inner_text('#toast'))
        async with page.expect_download() as d: await page.click('#btnExport')
        dl = await d.value; import os; print('export:', dl.suggested_filename, os.path.getsize(await dl.path()))
        await page.keyboard.down('KeyX'); await page.wait_for_timeout(80); print('keys X:', hex(await page.evaluate('window.__keys')))
        await page.keyboard.up('KeyX')
        await page.set_input_files('#romInput', 'test/build/ppu_thumb.gba'); await page.wait_for_timeout(1500)
        await page.locator('#screen').screenshot(path='test/w_ppu.png')
        print('erros:', errs)
        await b.close()
asyncio.run(main())
