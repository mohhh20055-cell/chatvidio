import re

with open('./public/student-dashboard.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Update URL parsing at the top of loadUserData
content = content.replace(
    "const sharedExercise = urlParams.get('exercise');",
    "const sharedExercise = urlParams.get('exercise');\n            const sharedPackage = urlParams.get('package') || urlParams.get('view_package');"
)

content = content.replace(
    "const hasShared = sharedPost || sharedOffer || sharedCourse || sharedGroup || sharedExercise;",
    "const hasShared = sharedPost || sharedOffer || sharedCourse || sharedGroup || sharedExercise || sharedPackage;"
)

# Update URL parsing at the end of loadUserData promise
content = content.replace(
    "const sharedExercise = urlParams.get('exercise');\n        const hasShared = sharedPost || sharedOffer || sharedCourse || sharedGroup || sharedExercise;",
    "const sharedExercise = urlParams.get('exercise');\n        const sharedPackage = urlParams.get('package') || urlParams.get('view_package');\n        const hasShared = sharedPost || sharedOffer || sharedCourse || sharedGroup || sharedExercise || sharedPackage;"
)

# Add logic to open modal
logic = """        } else if (sharedPackage) {
            showSection('packages');
            if (typeof loadStudentPackages === 'function') {
                loadStudentPackages().then(() => {
                    if (typeof openPackageDetailsModal === 'function') {
                        openPackageDetailsModal(sharedPackage);
                    }
                });
            } else {
                if (typeof openPackageDetailsModal === 'function') openPackageDetailsModal(sharedPackage);
            }
            hidePreloader(true);
        } else if (sharedPost) {"""

content = content.replace("} else if (sharedPost) {", logic)

with open('./public/student-dashboard.html', 'w', encoding='utf-8') as f:
    f.write(content)
