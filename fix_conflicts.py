import re

with open('server.js', 'r') as f:
    content = f.read()

# Replace <<<<<<< HEAD ... ======= ... >>>>>>> ...
content = re.sub(r'<<<<<<< HEAD\n(.*?)\n=======\n.*?\n>>>>>>>.*?\n', r'\1\n', content, flags=re.DOTALL)

with open('server.js', 'w') as f:
    f.write(content)
