import os
import re

def remove_conflict_markers(directory):
    # Conflict markers: <<<<<<<, =======, >>>>>>>
    pattern = re.compile(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>>.*?\n', re.DOTALL)
    
    for root, dirs, files in os.walk(directory):
        if '.git' in dirs:
            dirs.remove('.git')
        if 'node_modules' in dirs:
            dirs.remove('node_modules')
            
        for file in files:
            file_path = os.path.join(root, file)
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                if '<<<<<<< HEAD' in content:
                    print(f"Cleaning {file_path}")
                    # Simple strategy: keep HEAD version
                    new_content = re.sub(r'<<<<<<< HEAD\n(.*?)\n=======\n.*?\n>>>>>>>.*?\n', r'\1\n', content, flags=re.DOTALL)
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.write(new_content)
            except Exception as e:
                print(f"Skipping {file_path}: {e}")

remove_conflict_markers('.')
