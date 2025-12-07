"""Setup configuration for wegent CLI."""

from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as f:
    long_description = f.read()

setup(
    name="wegent",
    version="1.0.0",
    description="Wegent command line tool - kubectl-style CLI for managing Wegent resources",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="WeCode-AI Team",
    author_email="team@wecode.ai",
    url="https://github.com/wecode-ai/wegent",
    packages=find_packages(),
    python_requires=">=3.10",
    install_requires=[
        "click>=8.0.0",
        "requests>=2.25.0",
        "PyYAML>=5.4.0",
    ],
    entry_points={
        "console_scripts": [
            "wegent=wegent.cli:main",
        ],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Environment :: Console",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: Apache Software License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: System :: Systems Administration",
    ],
    keywords="wegent cli kubectl agent ai",
)
