import asyncio
from playwright.async_api import async_playwright
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        page = await (await b.new_context(viewport={'width': 1600, 'height': 1000})).new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto('file://' + __import__('os').path.abspath('dist/index.html'))
        await page.set_input_files('#romInput', 'test/build/heavysave_thumb.gba'); await page.wait_for_timeout(3000)
        print('1x com save gravando:', await page.inner_text('#status'))
        await page.select_option('#ffSpeed', '4'); await page.click('#btnFF')
        for i in range(3):
            await page.wait_for_timeout(2000); print('4x com save gravando:', await page.inner_text('#status'))
        n = await page.evaluate("JSON.parse(localStorage.getItem('gba.save-' + Object.keys(localStorage).find(k=>k.startsWith('gba.save-')).slice(9))).t")
        print('último save gravado há', await page.evaluate(f"Date.now()-{n}"), 'ms; erros:', errs)
        await b.close()
asyncio.run(main())
