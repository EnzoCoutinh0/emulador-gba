import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome')
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('file://' + __import__('os').path.abspath('dist/index.html'))
        await page.set_input_files('#romInput', 'test/build/flash_thumb.gba')
        await page.wait_for_timeout(4000)
        keys = await page.evaluate("Object.keys(localStorage)")
        print('localStorage:', keys)
        await page.screenshot(path='test/shot_mobile2.png')
        # recarrega e confere restauração
        await page.reload(); await page.wait_for_timeout(300)
        await page.set_input_files('#romInput', 'test/build/flash_thumb.gba')
        await page.wait_for_timeout(600)
        print('toast:', await page.inner_text('#toast'))
        # save state / load state
        await page.click('#btnSaveState'); await page.wait_for_timeout(1500)
        print('toast:', await page.inner_text('#toast'))
        await page.click('#btnLoadState'); await page.wait_for_timeout(1500)
        print('toast:', await page.inner_text('#toast'), 'status:', await page.inner_text('#status'))
        print('errs', errs)
        await b.close()
asyncio.run(main())
