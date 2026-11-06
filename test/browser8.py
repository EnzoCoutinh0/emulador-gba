import asyncio
from playwright.async_api import async_playwright
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000}, accept_downloads=True)
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await page.goto('file://' + __import__('os').path.abspath('dist/index.html'))
        await page.set_input_files('#romInput', 'test/build/ppu_thumb.gba'); await page.wait_for_timeout(1500)
        print('filtro:', await page.evaluate("__emu.renderer.filter"))
        async with page.expect_download() as d: await page.click('#btnShot')
        dl = await d.value; await dl.save_as('test/shot4k_xbr.png'); print('captura:', dl.suggested_filename)
        await page.evaluate("(()=>{const s=document.querySelector('#filter'); s.value='scale4x'; s.dispatchEvent(new Event('change'));})()")
        async with page.expect_download() as d: await page.click('#btnShot')
        await (await d.value).save_as('test/shot4k_s4x.png')
        await page.evaluate("(()=>{const s=document.querySelector('#filter'); s.value='sharp'; s.dispatchEvent(new Event('change'));})()")
        async with page.expect_download() as d: await page.click('#btnShot')
        await (await d.value).save_as('test/shot4k_sharp.png')
        print('erros:', [e for e in errs if 'GL Driver' not in e])
        await b.close()
asyncio.run(main())
