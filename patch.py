import re

with open('packages/app/app/(app)/admin/page.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    '<TabsList className="grid w-full grid-cols-4 md:grid-cols-7">',
    '<TabsList className="grid w-full grid-cols-4 md:grid-cols-8">'
)

content = content.replace(
    '<TabsTrigger value="credits">Credits</TabsTrigger>',
    '<TabsTrigger value="credits">Credits</TabsTrigger>\n          <TabsTrigger value="swarm">Swarm</TabsTrigger>'
)

content = content.replace(
    '<TabsContent value="credits" className="pt-4"><CreditsPanel /></TabsContent>',
    '<TabsContent value="credits" className="pt-4"><CreditsPanel /></TabsContent>\n        <TabsContent value="swarm" className="pt-4">\n          <div className="flex flex-col items-center justify-center p-12 text-center border rounded-lg bg-muted/20">\n             <h3 className="text-xl font-bold mb-2">Swarm Commander</h3>\n             <p className="text-muted-foreground mb-4">Autonomous bots and load testing suite.</p>\n             <Button onClick={() => window.location.href=\'/admin/swarm\'}>Open Commander HUD</Button>\n          </div>\n        </TabsContent>'
)

with open('packages/app/app/(app)/admin/page.tsx', 'w') as f:
    f.write(content)
