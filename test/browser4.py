import asyncio, re
from playwright.async_api import async_playwright
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=ARGS)
        ctx = await b.new_context(viewport={'width': 1600, 'height': 1000})
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await page.goto('file://' + __import__('os').path.abspath('dist/index.html'))
        print('webgl:', await page.evaluate("!!__emu.renderer.gl"))
        await page.set_input_files('#romInput', 'test/build/heavy_thumb.gba')
        await page.wait_for_timeout(3000)
        print('1x  :', await page.inner_text('#status'))
        await page.click('#btnFF'); await page.select_option('#ffSpeed', '4'); await page.wait_for_timeout(3000)
        print('4x  :', await page.inner_text('#status'))
        await page.select_option('#ffSpeed', '0'); await page.wait_for_timeout(3000)
        print('máx :', await page.inner_text('#status'))
        await page.click('#btnFF'); await page.wait_for_timeout(1500)
        print('volta 1x:', await page.inner_text('#status'))
        # filtros
        await page.set_input_files('#romInput', 'test/build/ppu_thumb.gba'); await page.wait_for_timeout(1000)
        for f in ['sharp', 'smooth', 'scale4x', 'scale4xs', 'lcd', 'crt']:
            await page.evaluate(f"(()=>{{const s=document.querySelector('#filter'); s.value='{f}'; s.dispatchEvent(new Event('change'));}})()")
            await page.wait_for_timeout(300)
            await page.locator('#screen').screenshot(path=f'test/f_{f}.png')
        print('saída:', await page.evaluate("__emu.renderer.outW + 'x' + __emu.renderer.outH"))
        # remapear A para K
        await page.click('#btnSettings'); await page.click('#kbTable tr[data-act=a] td:nth-child(2) .bind')
        await page.keyboard.press('KeyK'); await page.wait_for_timeout(100)
        print('A agora:', await page.evaluate("__emu.settings().kb.a"))
        await page.keyboard.press('Escape'); await page.wait_for_timeout(100)
        await page.keyboard.down('KeyK'); await page.wait_for_timeout(120)
        print('KEYINPUT com K:', hex(await page.evaluate("window.__keys")))
        await page.keyboard.up('KeyK'); await page.wait_for_timeout(120)
        print('KEYINPUT solto:', hex(await page.evaluate("window.__keys")))
        # gamepad falso
        await page.evaluate("""(()=>{ const btns=[...Array(17)].map(()=>({pressed:false,value:0})); window.__fake={id:'Controle Teste (STANDARD GAMEPAD)',mapping:'standard',buttons:btns,axes:[0,0,0,0],connected:true,index:0};
          navigator.getGamepads=()=>[window.__fake]; })()""")
        await page.evaluate("__fake.buttons[1].pressed=true"); await page.wait_for_timeout(120)
        print('gamepad b1 (A):', hex(await page.evaluate("window.__keys")))
        await page.evaluate("__fake.buttons[1].pressed=false; __fake.axes[0]=-0.9"); await page.wait_for_timeout(120)
        print('analógico ←:', hex(await page.evaluate("window.__keys")))
        await page.evaluate("__fake.axes[0]=0")
        await page.click('#btnSettings'); await page.click('.tabs button[data-tab=gp]')
        await page.click('#gpTable tr[data-act=start] td:nth-child(2) .bind'); await page.wait_for_timeout(100)
        await page.evaluate("__fake.buttons[6].pressed=true"); await page.wait_for_timeout(150)
        await page.evaluate("__fake.buttons[6].pressed=false"); await page.wait_for_timeout(100)
        print('Start no gamepad:', await page.evaluate("__emu.settings().gp.start"))
        await page.screenshot(path='test/shot_settings_gp.png')
        await page.click('.tabs button[data-tab=video]'); await page.screenshot(path='test/shot_settings_video.png')
        print('erros:', errs)
        await b.close()
asyncio.run(main())
